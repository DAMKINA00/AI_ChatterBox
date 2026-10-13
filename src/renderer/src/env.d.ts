import type { ChatterBoxApi } from "../../shared/types";

declare global {
  interface Window {
    chatterbox: ChatterBoxApi;
  }
}
