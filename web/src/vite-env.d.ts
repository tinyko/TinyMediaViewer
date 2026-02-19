/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TMV_APP_VERSION?: string;
  readonly VITE_TMV_SHORT_COMMIT?: string;
  readonly VITE_TMV_BUILD_TIME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
