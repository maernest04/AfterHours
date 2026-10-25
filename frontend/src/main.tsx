import { createRoot } from "react-dom/client";
import App from "./App";
import ConnectedApp from "./ConnectedApp";
import "./styles.css";

const connected = import.meta.env.VITE_CONNECTED_MODE === "true" || Boolean(import.meta.env.VITE_REVIEW_ID);
createRoot(document.getElementById("root")!).render(connected ? <ConnectedApp /> : <App />);
