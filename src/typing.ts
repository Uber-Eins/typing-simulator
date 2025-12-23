import * as vscode from "vscode";
import { EOL, State } from "./state";

interface TypingProps {
  text: string;
  state: State;
  pos?: vscode.Position;
}

async function typing(props: TypingProps): Promise<void> {
  const currentText = props.state.typingText;
  if (!currentText || currentText.length == 0 || props.state.status != "typing") return;
  var text = currentText;
  const eol = props.state.eol;

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri != props.state.currentDocument) {
    props.state.setStatus("stoped");
    return;
  }

  var pos =
    props.state.mode == "manual"
      ? editor.selection.active
      : props.state.position ?? props.pos ?? editor.selection.active;

  if (props.state.mode == "auto") {
    const selection = new vscode.Selection(pos, pos);
    if (!selection.isEqual(editor.selection)) {
      editor.selection = selection;
    }
  }

  const textAction = applyActions(text, pos, props.state);

  if (!textAction) return;

  text = textAction;

  const indentationSkip = trySkipIndentation(text, editor, pos);
  if (indentationSkip) {
    const nextText = text.substring(indentationSkip.consumeLength, text.length);
    props.state.setTypingText(nextText);
    props.state.setPosition(indentationSkip.newPos);
    nextBuffer(nextText, indentationSkip.newPos, props.state);
    return;
  }

  const nextChunk = getNextChunk(text, eol);
  if (!nextChunk) return;

  const { textToType, consumeLength, expectedText } = nextChunk;

  const skippedPosition = trySkipExistingChar(expectedText, editor, pos);
  if (skippedPosition) {
    const nextText = text.substring(consumeLength, text.length);
    props.state.setTypingText(nextText);
    props.state.setPosition(skippedPosition);
    nextBuffer(nextText, skippedPosition, props.state);
    return;
  }

  const startVersion = editor.document.version;
  props.state.setPendingType(expectedText, startVersion);
  await typeText(textToType);
  if (editor.document.version == startVersion) {
    props.state.clearPendingType();
    return;
  }

  const nextText = text.substring(consumeLength, text.length);
  props.state.setTypingText(nextText);
  const newPos = editor.selection.active;
  props.state.setPosition(newPos);
  nextBuffer(nextText, newPos, props.state);
}

async function writeText(text: string, pos: vscode.Position) {
  return new Promise<void>((resolve, reject) => {
    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw new Error("No active editor");
      editor
        .edit(function (editBuilder) {
          editBuilder.insert(pos, text);
        })
        .then(
          () => {
            resolve();
          },
          () => {
            throw new Error("Error on write text");
          },
        );
    } catch (e) {
      reject();
    }
  });
}

async function typeText(text: string) {
  try {
    await vscode.commands.executeCommand("default:type", { text });
  } catch {
    // Let caller decide how to recover.
  }
}

function delayTyping(text: string, pos: vscode.Position, state: State) {
  const sppedMultiplier = state.speed == "slow" ? 200 : state.speed == "medium" ? 100 : 50;
  let delay = sppedMultiplier * Math.random();
  if (Math.random() < 0.1)
    delay += state.speed == "slow" ? 300 : state.speed == "medium" ? 250 : 130;

  setTimeout(function () {
    typing({
      text: text,
      pos: pos,
      state,
    });
  }, delay);
}

function nextBuffer(text: string, pos: vscode.Position, state: State) {
  if (state.status == "typing" && state.mode == "auto") {
    delayTyping(text, pos, state);
  }
}

function applyActions(text: string, pos: vscode.Position, state: State): string | null {
  const eolChar = state.eol == "lf" ? "\n" : "\r\n";
  const eolLength = eolChar.length;
  const endOfLinePos = text.indexOf(eolChar);
  const currentLine = text.split(eolChar)[0];

  if (currentLine.trim().match(/(\/\/|#)\[ignore\]/)) {
    text = text.substring(currentLine.length + eolLength, text.length);
    const newPos = new vscode.Position(pos.line, 0);
    state.setTypingText(text);
    state.setPosition(newPos);
    nextBuffer(text, newPos, state);
    return null;
  }

  if (currentLine.trim().match(/(\/\/|#)\[quick\]/)) {
    const quickText = currentLine.replace(/(\/\/|#)\[quick\]/, "");
    writeText(quickText, new vscode.Position(pos.line, 0));
    text = text.substring(endOfLinePos, text.length);
    const newPos = new vscode.Position(pos.line + 1, 0);
    state.setTypingText(text);
    state.setPosition(newPos);
    nextBuffer(text, newPos, state);
    return null;
  }

  const alone = Boolean(currentLine.trim().match(/^\s*(\/\/|#)\[pause\]\s*/) && pos.character == 0);
  if (currentLine.trim().match(/^(\/\/|#)\[pause\]/) || alone) {
    state.setStatus("paused");
    text = text.substring(alone ? currentLine.length + eolLength : endOfLinePos, text.length);
    state.setTypingText(text);
    state.setPosition(pos);
    return null;
  }

  return text;
}

function getNextChunk(text: string, eol: EOL) {
  if (!text || text.length == 0) return null;
  if (eol == "crlf" && text.startsWith("\r\n")) {
    return { textToType: "\n", consumeLength: 2, expectedText: "\r\n" };
  }
  return { textToType: text.substring(0, 1), consumeLength: 1, expectedText: text.substring(0, 1) };
}

function trySkipIndentation(
  text: string,
  editor: vscode.TextEditor,
  pos: vscode.Position,
): { consumeLength: number; newPos: vscode.Position } | null {
  if (!text || text.length == 0) return null;
  if (text[0] != " " && text[0] != "\t") return null;

  const line = editor.document.lineAt(pos.line);
  if (pos.character == 0) return null;
  if (pos.character != line.firstNonWhitespaceCharacterIndex) return null;
  if (line.text.slice(0, pos.character).trim().length > 0) return null;

  let consumeLength = 0;
  while (consumeLength < text.length) {
    const char = text[consumeLength];
    if (char != " " && char != "\t") break;
    consumeLength += 1;
  }

  if (consumeLength == 0) return null;
  return { consumeLength, newPos: pos };
}

function trySkipExistingChar(
  expectedText: string,
  editor: vscode.TextEditor,
  pos: vscode.Position,
): vscode.Position | null {
  if (!expectedText) return null;
  const document = editor.document;
  const line = document.lineAt(pos.line);

  if (expectedText == "\n" || expectedText == "\r\n") {
    if (pos.character == line.text.length && pos.line < document.lineCount - 1) {
      const newPos = new vscode.Position(pos.line + 1, 0);
      editor.selection = new vscode.Selection(newPos, newPos);
      return newPos;
    }
    return null;
  }

  if (pos.character < line.text.length && line.text.charAt(pos.character) == expectedText) {
    const newPos = new vscode.Position(pos.line, pos.character + 1);
    editor.selection = new vscode.Selection(newPos, newPos);
    return newPos;
  }

  return null;
}

export { typing, applyActions, delayTyping };
