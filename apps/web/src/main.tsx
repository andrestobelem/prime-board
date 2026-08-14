// Punto de entrada de la UI.
// Conveniencia local-first: /?key=pb_xxx guarda la API key y limpia la URL,
// para poder compartir un link de onboarding en un board local.
import { createRoot } from "react-dom/client";
import { setApiKey } from "./api.ts";
import { App } from "./App.tsx";
import { watchSystemTheme } from "./theme.ts";
import "./styles.css";

watchSystemTheme();

const params = new URLSearchParams(window.location.search);
const keyFromUrl = params.get("key");
if (keyFromUrl) {
  setApiKey(keyFromUrl);
  params.delete("key");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
}

createRoot(document.getElementById("root")!).render(<App />);
