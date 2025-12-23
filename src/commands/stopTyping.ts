import Controller from "../controller";

const stopTyping = () => {
  const controller = Controller.getInstance();
  controller.stopTyping();
};

export default stopTyping;
