import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitProvider } from "connectkit";
import { Toaster } from "sonner";
import { wagmiConfig } from "./config";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          theme="midnight"
          customTheme={{
            "--ck-font-family": '"DM Sans", system-ui, sans-serif',
            "--ck-border-radius": "12px",
            "--ck-body-background": "#122d45",
            "--ck-body-color": "#e8f0f8",
            "--ck-primary-button-background": "#acc6e9",
            "--ck-primary-button-color": "#0d1b2f",
          }}
        >
          <App />
          <Toaster
            position="top-right"
            toastOptions={{
              style: { background: "#122d45", border: "1px solid #1e3a52", color: "#e8f0f8" },
            }}
          />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
