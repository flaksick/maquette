// Device facts for the report. Safari hides the model and RAM, so these are context only;
// the measured spikes are what set the budgets.

interface GpuLike {
  requestAdapter(): Promise<{
    info?: { vendor?: string; architecture?: string; description?: string };
    limits: Record<string, number>;
    features: Set<string>;
  } | null>;
}

export async function deviceInfo(): Promise<Record<string, unknown>> {
  const nav = navigator as Navigator & { deviceMemory?: number; standalone?: boolean; gpu?: GpuLike };
  let webgpu: unknown = 'absent';
  if (nav.gpu) {
    try {
      const ad = await nav.gpu.requestAdapter();
      webgpu = ad
        ? {
            info: ad.info ?? null,
            maxBufferSize: ad.limits.maxBufferSize,
            maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize,
            features: [...ad.features],
          }
        : 'no adapter';
    } catch (e) {
      webgpu = String(e);
    }
  }
  let estimate: unknown = null;
  let persisted: unknown = null;
  try {
    estimate = await navigator.storage.estimate();
    persisted = await navigator.storage.persisted();
  } catch (e) {
    estimate = String(e);
  }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
    viewport: { width: innerWidth, height: innerHeight },
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    displayModeStandalone: matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: nav.standalone ?? null,
    crossOriginIsolated,
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    webgpu,
    storageEstimate: estimate,
    storagePersisted: persisted,
    serviceWorkerControlled: !!navigator.serviceWorker?.controller,
  };
}
