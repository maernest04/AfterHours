import { createRoot } from "react-dom/client";
import App from "./App";
import ConnectedApp from "./ConnectedApp";
import "./styles.css";

const queryReview = new URLSearchParams(window.location.search).get("review") || "";
const connected = import.meta.env.VITE_CONNECTED_MODE === "true" || Boolean(import.meta.env.VITE_REVIEW_ID) || /^[1-9][0-9]{0,19}$/.test(queryReview);
createRoot(document.getElementById("root")!).render(connected ? <ConnectedApp /> : <App />);
