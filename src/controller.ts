import * as vscode from "vscode";
import { Mode, Speed, State } from "./state";
import { typing } from "./typing";
import Queue from "promise-queue";

class Controller {
  private static instance: Controller;
  private state: State;
  private typingConcurrency = 1;
  private typingQueueMaxSize = Number.MAX_SAFE_INTEGER;
  private typingQueue: Queue;
  private lastDocumentText = "";

  private constructor() {
    this.state = new State();
    this.typingQueue = new Queue(this.typingConcurrency, this.typingQueueMaxSize);
    vscode.workspace.onDidChangeTextDocument((event) => {
      this.handleDocumentChange(event);
    });
  }

  public static getInstance(): Controller {
    if (!Controller.instance) {
      Controller.instance = new Controller();
    }
    return Controller.instance;
  }

  public startTyping(text: string, document: vscode.TextDocument, position?: vscode.Position) {
    vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
      if (document.uri != this.state.currentDocument) return;
      this.state.setStatus("stoped");
      vscode.window.showInformationMessage(
        "Typing Simulator: I stopped the simulator because you closed the file.",
      );
      return;
    });

    this.state.setCurrentDocument(document.uri);
    this.loadConfigurations();
    this.state.setTypingText(text);
    const docEol = document.eol ?? vscode.EndOfLine.LF;
    this.state.eol = docEol == vscode.EndOfLine.LF ? "lf" : "crlf";
    this.state.setStatus("typing");
    this.state.setPosition(position ?? new vscode.Position(0, 0));
    this.state.clearPendingType();
    this.lastDocumentText = document.getText();
    if (this.state.mode == "auto") {
      typing({ text: text, state: this.state, pos: position ?? new vscode.Position(0, 0) });
    }
  }

  public continueTyping() {
    if (this.state.status == "standby") {
      vscode.window.showErrorMessage("Typing Simulator: You need to start typing.");
      return;
    }
    this.loadConfigurations();
    this.state.setStatus("typing");
    typing({
      text: this.state.typingText,
      pos: this.state.position,
      state: this.state,
    });
  }

  public stopTyping() {
    this.state.setStatus("standby");
  }

  public bindKeys(text: string) {
    if (this.state.status == "typing" && this.state.mode == "manual") {
      this.typingQueue.add(() => {
        return typing({
          text: this.state.typingText,
          pos: this.state.position,
          state: this.state,
        });
      });
    } else if (this.state.status == "paused" && this.state.mode == "manual") {
      vscode.commands.executeCommand("default:type", { text });
      if (text == "\n") {
        this.state.setStatus("typing");
      }
      //waiting enter
    } else {
      vscode.commands.executeCommand("default:type", { text });
    }
  }

  private loadConfigurations() {
    const config = vscode.workspace.getConfiguration("typingSimulator");
    this.state.setMode(config.get<Mode>("mode") ?? "auto");
    this.state.setSpeed(config.get<Speed>("speed") ?? "medium");
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
    if (!this.state.currentDocument || event.document.uri != this.state.currentDocument) return;

    const previousText = this.lastDocumentText;
    this.lastDocumentText = event.document.getText();

    this.updatePositionFromEditor(event.document);

    if (this.state.status != "typing") return;

    if (this.state.pendingTypeText) {
      let remainingText = this.state.typingText;
      for (const change of event.contentChanges) {
        if (change.rangeLength == 0) continue;
        const deletedText = previousText.slice(
          change.rangeOffset,
          change.rangeOffset + change.rangeLength,
        );
        if (deletedText.length > 0) {
          remainingText = deletedText + remainingText;
        }
      }
      if (remainingText != this.state.typingText) {
        this.state.setTypingText(remainingText);
      }
      if (
        this.state.pendingTypeVersion == null ||
        event.document.version > this.state.pendingTypeVersion
      ) {
        this.state.clearPendingType();
      }
      return;
    }

    let remainingText = this.state.typingText;

    for (const change of event.contentChanges) {
      const deletedText = previousText.slice(
        change.rangeOffset,
        change.rangeOffset + change.rangeLength,
      );
      if (deletedText.length > 0) {
        remainingText = deletedText + remainingText;
      }
      if (change.text.length > 0) {
        remainingText = consumeMatchingPrefix(remainingText, change.text);
      }
    }

    this.state.setTypingText(remainingText);
  }

  private updatePositionFromEditor(document: vscode.TextDocument) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri != document.uri) return;
    this.state.setPosition(editor.selection.active);
  }
}

function consumeMatchingPrefix(remaining: string, inserted: string): string {
  let remainingIndex = 0;
  let insertedIndex = 0;

  while (remainingIndex < remaining.length && insertedIndex < inserted.length) {
    const remainingChar = remaining[remainingIndex];
    const insertedChar = inserted[insertedIndex];

    if (remainingChar === insertedChar) {
      remainingIndex += 1;
      insertedIndex += 1;
      continue;
    }

    if (
      remainingChar === "\r" &&
      remaining[remainingIndex + 1] === "\n" &&
      insertedChar === "\n"
    ) {
      remainingIndex += 2;
      insertedIndex += 1;
      continue;
    }

    if (
      remainingChar === "\n" &&
      insertedChar === "\r" &&
      inserted[insertedIndex + 1] === "\n"
    ) {
      remainingIndex += 1;
      insertedIndex += 2;
      continue;
    }

    break;
  }

  return remaining.slice(remainingIndex);
}

export default Controller;
