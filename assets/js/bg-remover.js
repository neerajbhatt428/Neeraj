/* ============================================================
   assets/js/bg-remover.js
   Client-side background removal engine.

   Two backends:
     - @imgly/background-removal  (U²-Net / IS-Net, fast & reliable)
     - Transformers.js             (RMBG-1.4 / RMBG-2.0, higher quality)

   Everything runs in the browser. No uploads, no server.
   ============================================================ */

const CDN_IMGLY = [
  'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm',
  'https://esm.sh/@imgly/background-removal@1.7.0',
  'https://unpkg.com/@imgly/background-removal@1.7.0/dist/index.mjs',
];

const CDN_TRANSFORMERS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm',
  'https://esm.sh/@huggingface/transformers@3',
];

const IMGLY_DATA = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';

/* ============================================================
   Model registry
   ============================================================ */

export const MODELS = {
  fast: {
    label: 'Fast',
    description: 'Quickest. Good for simple subjects on simple backgrounds.',
    engine: 'imgly',
    imglyModel: 'isnet_quint8',
    sizeHint: '~30 MB first download',
  },
  balanced: {
    label: 'Balanced',
    description: 'Best speed-to-quality trade-off. Recommended default.',
    engine: 'imgly',
    imglyModel: 'isnet_fp16',
    sizeHint: '~80 MB first download',
  },
  high: {
    label: 'High quality',
    description: 'RMBG-1.4 via Transformers.js. Sharper edges, better hair.',
    engine: 'transformers',
    transformersModel: 'briaai/RMBG-1.4',
    sizeHint: '~45 MB first download',
  },
  ultra: {
    label: 'Ultra (slow)',
    description: 'RMBG-2.0. Top quality, largest download, may need WebGPU.',
    engine: 'transformers',
    transformersModel: 'briaai/RMBG-2.0',
    sizeHint: '~175 MB first download',
  },
};

/* ============================================================
   Internal cache
   ============================================================ */

const state = {
  imglyFn: null,
  imglyPreload: null,
  imglyPromise: null,
  tf: null,
  tfPromise: null,
  segmenters: {}, // keyed by transformers model id
  loadedModel: null,
};

/* ============================================================
   Helpers
   ============================================================ */

async function importFirst(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      return await import(/* @vite-ignore */ url);
    } catch (e) {
      lastErr = e;
      console.warn('[bg-remover] import failed:', url, e);
    }
  }
  throw lastErr || new Error('All CDN sources failed to load.');
}

export async function isWebGPUAvailable() {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/* ============================================================
   IMGLY loader
   ============================================================ */

async function ensureImgly() {
  if (state.imglyFn) return state.imglyFn;
  if (state.imglyPromise) return state.imglyPromise;

  state.imglyPromise = (async () => {
    const mod = await importFirst(CDN_IMGLY);
    const fn = mod.removeBackground || mod.default;
    if (typeof fn !== 'function') {
      throw new Error('imgly: removeBackground export not found');
    }
    state.imglyFn = fn;
    state.imglyPreload = mod.preload || null;
    return fn;
  })();

  return state.imglyPromise;
}

/* ============================================================
   Transformers.js loader
   ============================================================ */

async function ensureTransformers() {
  if (state.tf) return state.tf;
  if (state.tfPromise) return state.tfPromise;

  state.tfPromise = (async () => {
    const mod = await importFirst(CDN_TRANSFORMERS);
    state.tf = mod;
    return mod;
  })();

  return state.tfPromise;
}

async function getSegmenter(modelId, onProgress) {
  if (state.segmenters[modelId]) return state.segmenters[modelId];
  const tf = await ensureTransformers();

  const hasGPU = await isWebGPUAvailable();
  const device = hasGPU ? 'webgpu' : 'wasm';

  const segmenter = await tf.pipeline('background-removal', modelId, {
    device,
    progress_callback: (p) => {
      if (!onProgress) return;
      if (p.status === 'progress' && p.total) {
        onProgress({
          phase: 'download',
          loaded: p.loaded,
          total: p.total,
          pct: Math.round((p.loaded / p.total) * 100),
        });
      } else if (p.status === 'ready') {
        onProgress({ phase: 'ready' });
      } else if (p.status === 'initiate') {
        onProgress({ phase: 'init', file: p.file });
      }
    },
  });

  state.segmenters[modelId] = segmenter;
  return segmenter;
}

/* ============================================================
   Public: preload (warm up without running)
   ============================================================ */

export async function preload(modelKey, onProgress) {
  const model = MODELS[modelKey];
  if (!model) throw new Error('Unknown model: ' + modelKey);

  if (model.engine === 'imgly') {
    const mod = await importFirst(CDN_IMGLY);
    state.imglyFn = mod.removeBackground || mod.default;
    state.imglyPreload = mod.preload || null;
    if (state.imglyPreload) {
      await state.imglyPreload({
        publicPath: IMGLY_DATA,
        device: 'cpu',
        model: model.imglyModel,
      });
    }
  } else {
    await getSegmenter(model.transformersModel, onProgress);
  }
  state.loadedModel = modelKey;
}

/* ============================================================
   Public: run background removal
   Returns { bitmap, width, height, source }
   ============================================================ */

export async function removeBackground(imageBlob, modelKey, onProgress) {
  const model = MODELS[modelKey];
  if (!model) throw new Error('Unknown model: ' + modelKey);

  try {
    const result =
      model.engine === 'imgly'
        ? await runImgly(imageBlob, model, onProgress)
        : await runTransformers(imageBlob, model, onProgress);
    state.loadedModel = modelKey;
    return result;
  } catch (err) {
    // Fallback chain: ultra → high → balanced → fast
    const fallback = fallbackFor(modelKey);
    if (fallback) {
      console.warn('[bg-remover]', modelKey, 'failed, falling back to', fallback, err);
      if (onProgress) onProgress({ phase: 'fallback', from: modelKey, to: fallback });
      return removeBackground(imageBlob, fallback, onProgress);
    }
    throw err;
  }
}

function fallbackFor(key) {
  const chain = { ultra: 'high', high: 'balanced', balanced: 'fast', fast: null };
  return chain[key];
}

/* ============================================================
   IMGLY execution
   ============================================================ */

async function runImgly(imageBlob, model, onProgress) {
  const fn = await ensureImgly();
  if (onProgress) onProgress({ phase: 'processing', msg: 'Detecting subject…' });

  const result = await fn(imageBlob, {
    publicPath: IMGLY_DATA,
    device: 'cpu',
    model: model.imglyModel,
    output: { format: 'image/png', quality: 1 },
    progress: (key, current, total) => {
      if (onProgress && total) {
        onProgress({
          phase: 'processing',
          key,
          loaded: current,
          total,
          pct: Math.round((current / total) * 100),
        });
      }
    },
  });

  const bitmap = await createImageBitmap(result);
  return { bitmap, width: bitmap.width, height: bitmap.height, source: 'imgly' };
}

/* ============================================================
   Transformers.js execution
   ============================================================ */

async function runTransformers(imageBlob, model, onProgress) {
  if (onProgress) onProgress({ phase: 'model', msg: 'Loading ' + model.label + '…' });
  const segmenter = await getSegmenter(model.transformersModel, onProgress);

  if (onProgress) onProgress({ phase: 'processing', msg: 'Detecting subject…' });
  const output = await segmenter(imageBlob);

  // Output is an array of RawImage with the cutout (alpha applied).
  const raw = Array.isArray(output) ? output[0] : output;

  let bitmap;
  if (raw instanceof ImageBitmap) {
    bitmap = raw;
  } else if (raw && typeof raw.toBlob === 'function') {
    bitmap = await createImageBitmap(await raw.toBlob());
  } else if (raw instanceof Blob) {
    bitmap = await createImageBitmap(raw);
  } else {
    throw new Error('Unexpected model output type');
  }

  return { bitmap, width: bitmap.width, height: bitmap.height, source: 'transformers' };
}

/* ============================================================
   Public: recommended model for this device
   ============================================================ */

export async function getRecommendedModel() {
  if (await isWebGPUAvailable()) return 'high';
  return 'balanced';
}

/* ============================================================
   Public: metadata
   ============================================================ */

export function getModelInfo(key) {
  return MODELS[key] || null;
}

export function getModelKeys() {
  return Object.keys(MODELS);
}
