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
type WebGpuBufferLike = { destroy?: () => void };
type WebGpuBindGroupLike = object;
type WebGpuShaderModuleLike = object;
type WebGpuRenderPipelineLike = {
  getBindGroupLayout(index: number): unknown;
};
type WebGpuRenderPassLike = {
  setPipeline(pipeline: WebGpuRenderPipelineLike): void;
  setBindGroup(index: number, bindGroup: WebGpuBindGroupLike): void;
  setVertexBuffer(slot: number, buffer: WebGpuBufferLike): void;
  draw(vertexCount: number, instanceCount?: number): void;
  end(): void;
};
type WebGpuCommandEncoderLike = {
  beginRenderPass(descriptor: object): WebGpuRenderPassLike;
  finish(): unknown;
};
type WebGpuQueueLike = {
  writeBuffer(buffer: WebGpuBufferLike, offset: number, data: Float32Array): void;
  submit(commands: unknown[]): void;
};
type WebGpuDeviceLike = {
  createShaderModule(config: { code: string }): WebGpuShaderModuleLike;
  createBuffer(config: { size: number; usage: number }): WebGpuBufferLike;
  createBindGroup(config: object): WebGpuBindGroupLike;
  createRenderPipeline(config: object): WebGpuRenderPipelineLike;
  createCommandEncoder(): WebGpuCommandEncoderLike;
  queue: WebGpuQueueLike;
};
type WebGpuAdapterLike = {
  requestDevice(): Promise<WebGpuDeviceLike>;
};
type WebGpuTextureLike = {
  createView(): unknown;
};
type WebGpuContextLike = {
  configure(config: object): void;
  getCurrentTexture(): WebGpuTextureLike;
};
type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter(): Promise<WebGpuAdapterLike | null>;
    getPreferredCanvasFormat(): string;
  };
};

const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
const GPU_BUFFER_USAGE_VERTEX = 0x0020;
const INSTANCE_FLOATS = 12;
const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;
const VIEWPORT_BUFFER_BYTES = 16;
const MAX_PARTICLE_INSTANCES = 320;
const MAX_HEART_INSTANCES = 80;
const INITIAL_INSTANCE_CAPACITY = MAX_PARTICLE_INSTANCES + MAX_HEART_INSTANCES;
const SHAPE_CODE = {
  circle: 0,
  triangle: 1,
  square: 2,
  heart: 3,
} as const;
const QUAD_VERTICES = new Float32Array([
  -1, -1,
  1, -1,
  -1, 1,
  -1, 1,
  1, -1,
  1, 1,
]);
const WEBGPU_SHADER = `
struct ViewportUniforms {
  size: vec2<f32>,
  padding: vec2<f32>,
};

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) alpha: f32,
  @location(2) shape: f32,
  @location(3) progress: f32,
  @location(4) color: vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) corner: vec2<f32>,
  @location(1) bounds: vec4<f32>,
  @location(2) style: vec4<f32>,
  @location(3) color_data: vec4<f32>,
) -> VsOut {
  let angle = style.x;
  let sin_angle = sin(angle);
  let cos_angle = cos(angle);
  let local_px = vec2<f32>(
    corner.x * bounds.z * 0.5,
    corner.y * bounds.w * 0.5,
  );
  let rotated = vec2<f32>(
    local_px.x * cos_angle - local_px.y * sin_angle,
    local_px.x * sin_angle + local_px.y * cos_angle,
  );
  let center_ndc = vec2<f32>(
    (bounds.x / viewport.size.x) * 2.0 - 1.0,
    1.0 - (bounds.y / viewport.size.y) * 2.0,
  );
  let offset_ndc = vec2<f32>(
    (rotated.x / viewport.size.x) * 2.0,
    -(rotated.y / viewport.size.y) * 2.0,
  );

  var out: VsOut;
  out.position = vec4<f32>(center_ndc + offset_ndc, 0.0, 1.0);
  out.local = corner;
  out.alpha = style.y;
  out.shape = style.z;
  out.progress = style.w;
  out.color = color_data.xyz;
  return out;
}

fn smooth_mask(distance_value: f32, feather: f32) -> f32 {
  return 1.0 - smoothstep(0.0, feather, distance_value);
}

fn circle_mask(local: vec2<f32>) -> f32 {
  return smooth_mask(length(local) - 1.0, 0.06);
}

fn square_mask(local: vec2<f32>) -> f32 {
  return smooth_mask(max(abs(local.x), abs(local.y)) - 1.0, 0.04);
}

fn triangle_mask(local: vec2<f32>) -> f32 {
  let half_width = clamp((local.y + 1.0) * 0.5, 0.0, 1.0);
  let horizontal = abs(local.x) - half_width;
  let vertical = abs(local.y) - 1.0;
  return smooth_mask(max(horizontal, vertical), 0.05);
}

fn heart_fill(local: vec2<f32>) -> f32 {
  let p = vec2<f32>(local.x * 0.95, -local.y * 1.1 + 0.2);
  let a = p.x * p.x + p.y * p.y - 1.0;
  let implicit = a * a * a - p.x * p.x * p.y * p.y * p.y;
  return 1.0 - smoothstep(0.0, 0.03, implicit);
}

fn heart_outline(local: vec2<f32>, progress: f32) -> f32 {
  let outer = heart_fill(local);
  let inner_scale = 0.72 + progress * 0.12;
  let inner = heart_fill(local / inner_scale);
  return clamp(outer - inner, 0.0, 1.0);
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  var mask = 0.0;
  if (input.shape < 0.5) {
    mask = circle_mask(input.local);
  } else if (input.shape < 1.5) {
    mask = triangle_mask(input.local);
  } else if (input.shape < 2.5) {
    mask = square_mask(input.local);
  } else {
    mask = heart_outline(input.local, input.progress);
  }

  let alpha = mask * input.alpha;
  return vec4<f32>(input.color, alpha);
}
`;

const alignTo = (value: number, alignment: number) =>
  Math.ceil(value / alignment) * alignment;

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

const hueToRgb = (hue: number): readonly [number, number, number] => {
  const normalizedHue = (((hue % 360) + 360) % 360) / 360;
  const saturation = 0.85;
  const lightness = 0.7;
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const toChannel = (t: number) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  return [
    toChannel(normalizedHue + 1 / 3),
    toChannel(normalizedHue),
    toChannel(normalizedHue - 1 / 3),
  ];
};

const particleExtent = (particle: EffectsParticle) => {
  switch (particle.shape) {
    case "triangle":
      return particle.size * 4;
    case "square":
      return particle.size * 3.4;
    default:
      return particle.size * 3;
  }
};

const heartExtent = (heart: EffectsHeart) => (16 + 36 * heart.progress) * heart.scale * 3.2;

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
  const shaderModule = device.createShaderModule({
    code: WEBGPU_SHADER,
  });
  const quadBuffer = device.createBuffer({
    size: QUAD_VERTICES.byteLength,
    usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
  });
  device.queue.writeBuffer(quadBuffer, 0, QUAD_VERTICES);

  const viewportBuffer = device.createBuffer({
    size: VIEWPORT_BUFFER_BYTES,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
        {
          arrayStride: INSTANCE_STRIDE,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x4" },
            { shaderLocation: 2, offset: 16, format: "float32x4" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: {
          buffer: viewportBuffer,
        },
      },
    ],
  });

  let instanceBuffer: WebGpuBufferLike | null = null;
  let instanceCapacity = 0;
  let viewportWidth = 1;
  let viewportHeight = 1;

  const ensureInstanceBuffer = (instanceCount: number) => {
    const safeCount = Math.max(instanceCount, 1);
    if (instanceBuffer && safeCount <= instanceCapacity) {
      return;
    }

    const nextCapacity = Math.max(
      safeCount,
      instanceCapacity ? instanceCapacity * 2 : INITIAL_INSTANCE_CAPACITY
    );
    const nextBuffer = device.createBuffer({
      size: alignTo(nextCapacity * INSTANCE_STRIDE, 256),
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    });

    instanceBuffer?.destroy?.();
    instanceBuffer = nextBuffer;
    instanceCapacity = nextCapacity;
  };

  const writeViewport = () => {
    device.queue.writeBuffer(
      viewportBuffer,
      0,
      new Float32Array([viewportWidth, viewportHeight, 0, 0])
    );
  };

  const buildInstances = (scene: EffectsScene) => {
    const totalInstances = scene.particles.length + scene.hearts.length;
    const instanceData = new Float32Array(Math.max(totalInstances, 1) * INSTANCE_FLOATS);
    let offset = 0;

    for (const particle of scene.particles) {
      const [red, green, blue] = hueToRgb(particle.hue);
      const extent = particleExtent(particle);
      instanceData[offset] = particle.x;
      instanceData[offset + 1] = particle.y;
      instanceData[offset + 2] = extent;
      instanceData[offset + 3] = extent;
      instanceData[offset + 4] = particle.angle;
      instanceData[offset + 5] = particle.life;
      instanceData[offset + 6] = SHAPE_CODE[particle.shape];
      instanceData[offset + 7] = 0;
      instanceData[offset + 8] = red;
      instanceData[offset + 9] = green;
      instanceData[offset + 10] = blue;
      offset += INSTANCE_FLOATS;
    }

    for (const heart of scene.hearts) {
      const [red, green, blue] = hueToRgb(heart.hue);
      const extent = heartExtent(heart);
      instanceData[offset] = heart.x;
      instanceData[offset + 1] = heart.y;
      instanceData[offset + 2] = extent;
      instanceData[offset + 3] = extent;
      instanceData[offset + 4] = 0;
      instanceData[offset + 5] = 1 - heart.progress;
      instanceData[offset + 6] = SHAPE_CODE.heart;
      instanceData[offset + 7] = heart.progress;
      instanceData[offset + 8] = red;
      instanceData[offset + 9] = green;
      instanceData[offset + 10] = blue;
      offset += INSTANCE_FLOATS;
    }

    return {
      instanceCount: totalInstances,
      instanceData,
    };
  };

  const submitClearPass = () => {
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
      viewportWidth = Math.max(1, Math.round(width));
      viewportHeight = Math.max(1, Math.round(height));
      writeViewport();
    },
    render(scene) {
      const { instanceCount, instanceData } = buildInstances(scene);
      if (!instanceCount) {
        submitClearPass();
        return;
      }

      ensureInstanceBuffer(instanceCount);
      if (!instanceBuffer) {
        submitClearPass();
        return;
      }

      device.queue.writeBuffer(instanceBuffer, 0, instanceData);

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
      pass.setVertexBuffer(0, quadBuffer);
      pass.setVertexBuffer(1, instanceBuffer);
      pass.draw(6, instanceCount);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    clear() {
      submitClearPass();
    },
    dispose() {
      instanceBuffer?.destroy?.();
      quadBuffer.destroy?.();
      viewportBuffer.destroy?.();
      instanceBuffer = null;
      instanceCapacity = 0;
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
