import ReactDOM from "react-dom/client";

import App from "./App";
import "./index.css";
import "./styles.css";

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("Missing #app root");
}

ReactDOM.createRoot(appRoot).render(<App />);
