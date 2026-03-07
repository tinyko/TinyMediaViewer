import type { EffectsRenderer } from "../../types";

type Shape = "circle" | "triangle" | "square";

export interface EffectsParticle {
  x: number;
  y: number;
  size: number;
  life: number;
  hue: number;
  shape: Shape;
  angle: number;
}

export interface EffectsHeart {
  x: number;
  y: number;
  progress: number;
  hue: number;
  scale: number;
}

export interface EffectsScene {
  width: number;
  height: number;
  particles: readonly EffectsParticle[];
  hearts: readonly EffectsHeart[];
}

export interface EffectsRendererAdapter {
  readonly kind: EffectsRenderer;
  resize(width: number, height: number): void;
  render(scene: EffectsScene): void;
  clear(width: number, height: number): void;
  dispose(): void;
}

type RasterContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type WebGpuBufferLike = object;
type WebGpuBindGroupLike = object;
type WebGpuTextureLike = {
  createView(): unknown;
  destroy(): void;
};
type WebGpuSamplerLike = object;
type WebGpuShaderModuleLike = object;
type WebGpuRenderPipelineLike = {
  getBindGroupLayout(index: number): unknown;
};
type WebGpuRenderPassLike = {
  setPipeline(pipeline: WebGpuRenderPipelineLike): void;
  setBindGroup(index: number, bindGroup: WebGpuBindGroupLike): void;
  setVertexBuffer(slot: number, buffer: WebGpuBufferLike): void;
  draw(vertexCount: number): void;
  end(): void;
};
type WebGpuCommandEncoderLike = {
  beginRenderPass(descriptor: {
    colorAttachments: Array<{
      view: unknown;
      clearValue: { r: number; g: number; b: number; a: number };
      loadOp: "clear";
      storeOp: "store";
    }>;
  }): WebGpuRenderPassLike;
  finish(): unknown;
};
type WebGpuQueueLike = {
  writeBuffer(buffer: WebGpuBufferLike, offset: number, data: Float32Array): void;
  copyExternalImageToTexture(
    source: { source: CanvasImageSource },
    destination: { texture: WebGpuTextureLike },
    size: { width: number; height: number }
  ): void;
  submit(commands: unknown[]): void;
};
type WebGpuDeviceLike = {
  createSampler(config: {
    magFilter: "linear";
    minFilter: "linear";
    addressModeU: "clamp-to-edge";
    addressModeV: "clamp-to-edge";
  }): WebGpuSamplerLike;
  createShaderModule(config: { code: string }): WebGpuShaderModuleLike;
  createBuffer(config: { size: number; usage: number }): WebGpuBufferLike;
  createRenderPipeline(config: {
    layout: "auto";
    vertex: {
      module: WebGpuShaderModuleLike;
      entryPoint: string;
      buffers: Array<{
        arrayStride: number;
        attributes: Array<{
          shaderLocation: number;
          offset: number;
          format: "float32x2";
        }>;
      }>;
    };
    fragment: {
      module: WebGpuShaderModuleLike;
      entryPoint: string;
      targets: Array<{ format: string }>;
    };
    primitive: { topology: "triangle-list" };
  }): WebGpuRenderPipelineLike;
  createTexture(config: {
    size: { width: number; height: number };
    format: "rgba8unorm";
    usage: number;
  }): WebGpuTextureLike;
  createBindGroup(config: {
    layout: unknown;
    entries: Array<{ binding: number; resource: unknown }>;
  }): WebGpuBindGroupLike;
  createCommandEncoder(): WebGpuCommandEncoderLike;
  queue: WebGpuQueueLike;
};
type WebGpuAdapterLike = {
  requestDevice(): Promise<WebGpuDeviceLike>;
};
type WebGpuContextLike = {
  configure(config: {
    device: WebGpuDeviceLike;
    format: string;
    alphaMode: "premultiplied";
  }): void;
  getCurrentTexture(): WebGpuTextureLike;
};
type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter(): Promise<WebGpuAdapterLike | null>;
    getPreferredCanvasFormat(): string;
  };
};

const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_VERTEX = 0x0020;
const GPU_TEXTURE_USAGE_COPY_DST = 0x0002;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x0004;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x0010;

const resizeSurface = (
  canvas: HTMLCanvasElement | OffscreenCanvas,
  width: number,
  height: number
) => {
  const cssWidth = Math.max(1, Math.round(width));
  const cssHeight = Math.max(1, Math.round(height));
  const dpr = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  if ("style" in canvas) {
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }

  return { cssWidth, cssHeight, dpr };
};

const makeRasterCanvas = () => {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d");
    if (context) {
      return { canvas, context };
    }
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is unavailable");
  }

  return { canvas, context };
};

const resizeCanvas = (
  canvas: HTMLCanvasElement | OffscreenCanvas,
  context: RasterContext2D,
  width: number,
  height: number
) => {
  const { dpr } = resizeSurface(canvas, width, height);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
};

const clearContext = (
  context: RasterContext2D,
  width: number,
  height: number
) => {
  context.clearRect(0, 0, width, height);
};

const drawHeart = (context: RasterContext2D, size: number) => {
  const s = size;
  context.moveTo(0, -0.6 * s);
  context.bezierCurveTo(-s, -0.8 * s, -1.2 * s, -0.1 * s, -0.1 * s, 0.9 * s);
  context.bezierCurveTo(1.2 * s, -0.1 * s, s, -0.8 * s, 0, -0.6 * s);
  context.closePath();
};

export const renderEffectsSceneTo2d = (
  context: RasterContext2D,
  scene: EffectsScene
) => {
  clearContext(context, scene.width, scene.height);

  for (const particle of scene.particles) {
    context.globalAlpha = particle.life;
    context.fillStyle = `hsla(${particle.hue}, 85%, 70%, ${particle.life})`;
    context.beginPath();
    if (particle.shape === "circle") {
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    } else if (particle.shape === "square") {
      const size = particle.size * 1.6;
      context.save();
      context.translate(particle.x, particle.y);
      context.rotate(particle.angle);
      context.rect(-size / 2, -size / 2, size, size);
      context.restore();
    } else {
      const size = particle.size * 2;
      context.save();
      context.translate(particle.x, particle.y);
      context.rotate(particle.angle);
      context.moveTo(0, -size / 2);
      context.lineTo(-size / 2, size / 2);
      context.lineTo(size / 2, size / 2);
      context.closePath();
      context.restore();
    }
    context.fill();
  }

  context.globalAlpha = 1;

  for (const heart of scene.hearts) {
    const size = (16 + 36 * heart.progress) * heart.scale;
    context.beginPath();
    context.save();
    context.translate(heart.x, heart.y);
    drawHeart(context, size);
    context.restore();
    context.strokeStyle = `hsla(${heart.hue}, 85%, 70%, ${1 - heart.progress})`;
    context.lineWidth = 2 * (1 - heart.progress * 0.6);
    context.stroke();
  }
};

const createNoopRenderer = (
  canvas: HTMLCanvasElement,
  kind: EffectsRenderer
): EffectsRendererAdapter => ({
  kind,
  resize(width, height) {
    resizeSurface(canvas, width, height);
  },
  render() {},
  clear() {},
  dispose() {},
});

const createCanvas2dRenderer = (
  canvas: HTMLCanvasElement
): EffectsRendererAdapter => {
  const context = canvas.getContext("2d");
  if (!context) {
    return createNoopRenderer(canvas, "canvas2d");
  }

  return {
    kind: "canvas2d",
    resize(width, height) {
      resizeCanvas(canvas, context, width, height);
    },
    render(scene) {
      renderEffectsSceneTo2d(context, scene);
    },
    clear(width, height) {
      clearContext(context, width, height);
    },
    dispose() {},
  };
};

const createWebGpuRenderer = async (
  canvas: HTMLCanvasElement
): Promise<EffectsRendererAdapter> => {
  const gpu = (navigator as NavigatorWithGpu).gpu;
  if (!gpu) {
    throw new Error("WebGPU is unavailable");
  }

  const context = canvas.getContext("webgpu") as WebGpuContextLike | null;
  if (!context) {
    throw new Error("WebGPU canvas context is unavailable");
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("Unable to acquire WebGPU adapter");
  }

  const device = await adapter.requestDevice();
  const format = gpu.getPreferredCanvasFormat();
  const { canvas: rasterCanvas, context: rasterContext } = makeRasterCanvas();
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const shaderModule = device.createShaderModule({
    code: `
struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@location(0) position: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut {
  var out: VsOut;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@group(0) @binding(0) var tex_sampler: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(tex, tex_sampler, in.uv);
}
`,
  });
  const vertexBuffer = device.createBuffer({
    size: 6 * 4 * 4,
    usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
  });
  device.queue.writeBuffer(
    vertexBuffer,
    0,
    new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      -1, 1, 0, 0,
      1, -1, 1, 1,
      1, 1, 1, 0,
    ])
  );

  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });

  let texture: WebGpuTextureLike | null = null;
  let bindGroup: WebGpuBindGroupLike | null = null;
  let textureWidth = 1;
  let textureHeight = 1;
  let viewportWidth = 1;
  let viewportHeight = 1;

  const ensureTexture = (width: number, height: number) => {
    if (texture && textureWidth === width && textureHeight === height) return;
    texture?.destroy();
    textureWidth = width;
    textureHeight = height;
    texture = device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage:
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture.createView() },
      ],
    });
  };

  context.configure({
    device,
    format,
    alphaMode: "premultiplied",
  });

  return {
    kind: "webgpu",
    resize(width, height) {
      resizeSurface(canvas, width, height);
      resizeCanvas(rasterCanvas, rasterContext, width, height);
      viewportWidth = Math.max(1, Math.round(width));
      viewportHeight = Math.max(1, Math.round(height));
      ensureTexture(rasterCanvas.width, rasterCanvas.height);
    },
    render(scene) {
      if (!texture || !bindGroup) return;
      renderEffectsSceneTo2d(rasterContext, scene);
      device.queue.copyExternalImageToTexture(
        { source: rasterCanvas },
        { texture },
        { width: textureWidth, height: textureHeight }
      );
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.draw(6);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    clear(width, height) {
      clearContext(rasterContext, width, height);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    dispose() {
      texture?.destroy();
      texture = null;
      bindGroup = null;
      if (viewportWidth > 0 && viewportHeight > 0) {
        clearContext(rasterContext, viewportWidth, viewportHeight);
      }
    },
  };
};

export const createEffectsRenderer = async (
  canvas: HTMLCanvasElement,
  kind: EffectsRenderer
): Promise<EffectsRendererAdapter> => {
  if (kind === "webgpu") {
    return createWebGpuRenderer(canvas);
  }
  return createCanvas2dRenderer(canvas);
};
