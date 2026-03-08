import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { postPerfDiagnostics } from "../../api";
import type { ViewerPreferences } from "../../types";
import { EffectsStage } from "../effects/EffectsStage";
import { useThemeAndPerf } from "./useThemeAndPerf";

vi.mock("../../api", () => ({
  postPerfDiagnostics: vi.fn(),
}));

const mockedPostPerfDiagnostics = vi.mocked(postPerfDiagnostics);

const makeViewerPreferences = (
  overrides: Partial<ViewerPreferences> = {}
): ViewerPreferences => ({
  search: "",
  sortMode: "time",
  randomSeed: 0,
  mediaSort: "desc",
  mediaRandomSeed: 0,
  mediaFilter: "image",
  categoryPath: undefined,
  theme: "light",
  manualTheme: false,
  effectsMode: "auto",
  effectsRenderer: "webgpu",
  ...overrides,
});

const make2dContext = () =>
  ({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    rect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    restore: vi.fn(),
    stroke: vi.fn(),
  }) as unknown as CanvasRenderingContext2D;

describe("useThemeAndPerf", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalGpu = Object.getOwnPropertyDescriptor(globalThis.navigator, "gpu");

  beforeEach(() => {
    mockedPostPerfDiagnostics.mockResolvedValue();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis.navigator, "gpu", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    if (originalGpu) {
      Object.defineProperty(globalThis.navigator, "gpu", originalGpu);
    } else {
      Reflect.deleteProperty(globalThis.navigator, "gpu");
    }
  });

  it("hydrates theme and effects preferences from the backend payload", async () => {
    const { result } = renderHook(() =>
      useThemeAndPerf({
        initialPreferences: makeViewerPreferences({
          theme: "dark",
          manualTheme: true,
          effectsMode: "full",
          effectsRenderer: "canvas2d",
        }),
        preferencesReady: true,
      })
    );

    await waitFor(() => {
      expect(result.current.preferencesHydrated).toBe(true);
    });
    expect(result.current.theme).toBe("dark");
    expect(result.current.manualTheme).toBe(true);
    expect(result.current.effectsMode).toBe("full");
    expect(result.current.effectsRenderer).toBe("canvas2d");
  });

  it("keeps a hydrated canvas2d preference until the user explicitly toggles it", async () => {
    const { result } = renderHook(() =>
      useThemeAndPerf({
        initialPreferences: makeViewerPreferences({
          effectsRenderer: "canvas2d",
        }),
        preferencesReady: true,
      })
    );

    await waitFor(() => {
      expect(result.current.preferencesHydrated).toBe(true);
    });
    expect(result.current.effectsRenderer).toBe("canvas2d");

    act(() => {
      result.current.toggleRenderer();
    });

    expect(result.current.effectsRenderer).toBe("webgpu");
  });

  it("shows WG× when webgpu was requested but the stage falls back to canvas2d", async () => {
    const context2d = make2dContext();

    Object.defineProperty(globalThis.navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: vi.fn(async () => ({
          requestDevice: vi.fn(async () => ({})),
        })),
        getPreferredCanvasFormat: vi.fn(() => "bgra8unorm"),
      },
    });

    HTMLCanvasElement.prototype.getContext = vi.fn(function getContext(kind: string) {
      if (kind === "2d") return context2d;
      if (kind === "webgpu") return null;
      return null;
    }) as typeof HTMLCanvasElement.prototype.getContext;

    function Harness() {
      const {
        effectsRenderer,
        resolvedRenderer,
        reportResolvedRenderer,
      } = useThemeAndPerf({
        initialPreferences: makeViewerPreferences({
          effectsRenderer: "webgpu",
        }),
        preferencesReady: true,
      });

      return (
        <>
          <div data-testid="renderer-label">
            {effectsRenderer === "webgpu"
              ? resolvedRenderer === "webgpu"
                ? "WG"
                : "WG×"
              : "2D"}
          </div>
          <EffectsStage
            enabled={false}
            requestedRenderer={effectsRenderer}
            hoveredCardRef={createRef<HTMLButtonElement>()}
            onHueChange={() => undefined}
            onResolvedRendererChange={reportResolvedRenderer}
            cursorOffset={{ x: 0, y: 0 }}
            pulseOffsetY={0}
          />
        </>
      );
    }

    render(<Harness />);

    await waitFor(() => {
      expect(screen.getByTestId("renderer-label")).toHaveTextContent("WG×");
    });
  });

  it("falls back to canvas2d when navigator.gpu is unavailable", async () => {
    const context2d = make2dContext();

    HTMLCanvasElement.prototype.getContext = vi.fn(function getContext(kind: string) {
      if (kind === "2d") return context2d;
      return null;
    }) as typeof HTMLCanvasElement.prototype.getContext;

    function Harness() {
      const {
        effectsRenderer,
        resolvedRenderer,
        reportResolvedRenderer,
      } = useThemeAndPerf({
        initialPreferences: makeViewerPreferences({
          effectsRenderer: "webgpu",
        }),
        preferencesReady: true,
      });

      return (
        <>
          <div data-testid="renderer-label">
            {effectsRenderer === "webgpu"
              ? resolvedRenderer === "webgpu"
                ? "WG"
                : "WG×"
              : "2D"}
          </div>
          <EffectsStage
            enabled={false}
            requestedRenderer={effectsRenderer}
            hoveredCardRef={createRef<HTMLButtonElement>()}
            onHueChange={() => undefined}
            onResolvedRendererChange={reportResolvedRenderer}
            cursorOffset={{ x: 0, y: 0 }}
            pulseOffsetY={0}
          />
        </>
      );
    }

    render(<Harness />);

    await waitFor(() => {
      expect(screen.getByTestId("renderer-label")).toHaveTextContent("WG×");
    });
  });
});
