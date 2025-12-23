import Controller from "../controller";

const manualTyping = ({ text }: { text: string }) => {
  const controller = Controller.getInstance();
  controller.bindKeys(text);
};

export default manualTyping;
