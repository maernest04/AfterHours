/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REVIEW_ID?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_CONNECTED_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
