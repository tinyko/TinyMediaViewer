import { expect, test } from "@playwright/test";

test.describe("Tiny Media Viewer", () => {
  test("loads fixture accounts, supports search, and opens system usage", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("button", { name: /^alpha-lounge\b/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^beta-station\b/ })).toBeVisible();

    await page.getByRole("searchbox", { name: "筛选账号名称" }).fill("beta");
    await expect(page.getByRole("button", { name: /^beta-station\b/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^alpha-lounge\b/ })).toHaveCount(0);

    await page.getByRole("searchbox", { name: "筛选账号名称" }).fill("");
    await page.getByRole("button", { name: "系统占用情况" }).click();

    const dialog = page.getByRole("dialog", { name: "系统占用情况" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("beta-station")).toBeVisible();
    await expect(dialog.getByText("最大文件 Top 5")).toBeVisible();
  });

  test("opens image and video previews from the fixture dataset", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /^alpha-lounge\b/ }).click();
    await expect(page.getByRole("button", { name: /IMG_20260307_000001\.png/ })).toBeVisible();

    await page.getByRole("button", { name: /IMG_20260307_000001\.png/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("dialog").getByRole("img", { name: "IMG_20260307_000001.png" })
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).last().click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "视频" }).click();
    await expect(page.getByRole("button", { name: /VID_20260307_000001\.mp4/ })).toBeVisible();

    await page.getByRole("button", { name: /VID_20260307_000001\.mp4/ }).click();
    await expect(page.locator("video")).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).last().click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
