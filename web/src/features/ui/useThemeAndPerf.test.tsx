import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { postPerfDiagnostics } from "../../api";
import { EffectsStage } from "../effects/EffectsStage";
import { useThemeAndPerf } from "./useThemeAndPerf";

vi.mock("../../api", () => ({
  postPerfDiagnostics: vi.fn(),
}));

const mockedPostPerfDiagnostics = vi.mocked(postPerfDiagnostics);

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
    window.localStorage.clear();
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

  it("migrates legacy renderer preferences to webgpu once", () => {
    window.localStorage.setItem("mv-effects-renderer", "canvas2d");

    const { result } = renderHook(() => useThemeAndPerf());

    expect(result.current.effectsRenderer).toBe("webgpu");
    expect(window.localStorage.getItem("mv-effects-renderer")).toBe("webgpu");
    expect(window.localStorage.getItem("mv-effects-renderer-migrated-v1")).toBe("true");
  });

  it("keeps a user-selected canvas2d preference after the migration already ran", () => {
    const { result, unmount } = renderHook(() => useThemeAndPerf());

    act(() => {
      result.current.toggleRenderer();
    });

    expect(window.localStorage.getItem("mv-effects-renderer")).toBe("canvas2d");
    expect(window.localStorage.getItem("mv-effects-renderer-migrated-v1")).toBe("true");

    unmount();

    const next = renderHook(() => useThemeAndPerf());
    expect(next.result.current.effectsRenderer).toBe("canvas2d");
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
      } = useThemeAndPerf();

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
