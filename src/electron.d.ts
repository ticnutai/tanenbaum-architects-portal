export {};
declare global {
  interface Window {
    mavatDesktop?: {
      selectDataFile(): Promise<string>;
      copyText(text: string): Promise<boolean>;
      platform: string;
    };
  }
}
