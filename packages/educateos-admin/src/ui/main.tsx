import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { AdminApp } from "./App.tsx";
import { createAdminClient } from "./app/client.ts";
import { THEME_KEY } from "./theme.ts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider source={storedThemeMode(THEME_KEY)}>
      <AdminApp client={createAdminClient()} />
    </ThemeProvider>
  </StrictMode>,
);
