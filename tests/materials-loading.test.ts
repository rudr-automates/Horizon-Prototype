import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MaterialsPanel } from "@/components/materials/materials-panel";

describe("MaterialsPanel loading state", () => {
  it("does not report an empty library before its source list arrives", () => {
    const html = renderToStaticMarkup(createElement(MaterialsPanel, {
      courseId: "course-1",
      playhead: 0,
      boundarySeconds: 0,
      resources: null,
      loading: true,
      error: null,
      isFixture: false,
      onOpenLearn: () => undefined,
    }));

    expect(html).toContain("Loading sources");
    expect(html).not.toContain("0 sources");
  });
});
