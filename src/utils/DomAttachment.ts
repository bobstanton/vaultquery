const ATTACH_POLL_MS = 16;
const ATTACH_TIMEOUT_MS = 10_000;

export async function waitForConnected(container: HTMLElement, isCurrent: () => boolean): Promise<boolean> {
  if (container.isConnected) return true;
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  const view = container.ownerDocument.defaultView ?? window;

  while (!container.isConnected && Date.now() < deadline) {
    await new Promise<void>(resolve => view.setTimeout(resolve, ATTACH_POLL_MS));
    if (!isCurrent()) return false;
  }

  return isCurrent();
}
