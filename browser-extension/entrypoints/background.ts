import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

export default defineBackground(() => {
  const enableSidePanel = () =>
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

  browser.runtime.onInstalled.addListener(enableSidePanel);
  browser.runtime.onStartup.addListener(enableSidePanel);
  void enableSidePanel();
});
