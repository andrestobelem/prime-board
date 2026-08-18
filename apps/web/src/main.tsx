// Punto de entrada de la UI.
// Un enlace /?key=pb_xxx se guarda temporalmente para que Settings confirme la
// conexión; nunca pisa silenciosamente una credencial existente.
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import {
  getOnboardingKeyFromSearch,
  stageOnboardingKey,
  stripOnboardingKey,
} from "./onboarding.ts";
import { watchSystemTheme } from "./theme.ts";
import "./styles.css";

watchSystemTheme();

const params = new URLSearchParams(window.location.search);
const keyFromUrl = getOnboardingKeyFromSearch(window.location.search);
if (params.has("key")) {
  // La key queda fuera de la URL y pendiente de confirmación explícita en Settings.
  // Si ya existe una credencial, Settings ofrece elegir la key invitada sin
  // reemplazarla automáticamente.
  if (keyFromUrl) stageOnboardingKey(keyFromUrl);
  const query = stripOnboardingKey(window.location.search);
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query}${window.location.hash}`,
  );
}

createRoot(document.getElementById("root")!).render(<App />);
