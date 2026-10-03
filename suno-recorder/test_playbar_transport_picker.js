const assert = require("assert");
const {
  pickPlaybarTransportButton,
  collectTitleScopeTransportButtons,
  collectPlaybarTransportButtons,
} = require("./playbar_transport_picker.js");

function mockButton({ label, pause, shown = true, rect = { height: 40, width: 40, top: 800, bottom: 840 } }) {
  return {
    shown,
    pause,
    rect,
    getAttribute(name) {
      return name === "aria-label" ? label : "";
    },
    getBoundingClientRect() {
      return this.rect;
    },
  };
}

const deps = {
  isShown: (btn) => btn.shown,
  buttonShowsPause: (btn) => btn.pause,
};

const hiddenStalePause = mockButton({ label: "Playbar: Pause", pause: true, shown: false });
const visiblePlay = mockButton({ label: "Playbar: Play", pause: false, shown: true });

assert.strictEqual(
  pickPlaybarTransportButton([hiddenStalePause, visiblePlay], false, deps),
  visiblePlay,
  "prefer play should ignore hidden stale pause controls"
);

const visiblePause = mockButton({ label: "Playbar: Pause", pause: true, shown: true });
assert.strictEqual(
  pickPlaybarTransportButton([hiddenStalePause, visiblePause], true, deps),
  visiblePause,
  "prefer pause should pick the on-screen pause control"
);

assert.strictEqual(
  pickPlaybarTransportButton([hiddenStalePause, visiblePlay], undefined, deps),
  visiblePlay,
  "legacy pick should not prefer a hidden pause over a visible control"
);

const visiblePlay2 = mockButton({ label: "Playbar: Play", pause: false, shown: true });
assert.strictEqual(
  pickPlaybarTransportButton([visiblePause, visiblePlay2], undefined, deps),
  visiblePause,
  "legacy pick should prefer the visible pause control when both are on screen"
);

function mockScopeTree() {
  const hiddenPause = mockButton({ label: "Pause", pause: true, shown: false });
  const visiblePlay = mockButton({ label: "Play", pause: false, shown: true });

  const innerScope = {
    parentElement: null,
    getBoundingClientRect: () => ({ height: 80 }),
    querySelectorAll(sel) {
      if (sel === "button[aria-label]") return [hiddenPause];
      return [];
    },
  };
  const outerScope = {
    parentElement: null,
    getBoundingClientRect: () => ({ height: 80 }),
    querySelectorAll(sel) {
      if (sel === "button[aria-label]") return [visiblePlay];
      return [];
    },
  };
  innerScope.parentElement = outerScope;

  const titleNode = {
    parentElement: innerScope,
    shown: true,
    getAttribute(name) {
      return name === "aria-label" ? "Playbar: Title" : "";
    },
    getBoundingClientRect: () => ({ height: 24, width: 120, top: 800, bottom: 824 }),
  };

  const doc = {
    querySelectorAll(sel) {
      if (sel === '[aria-label*="Playbar: Title"]') return [titleNode];
      return [];
    },
  };

  return { hiddenPause, visiblePlay, doc };
}

const scopeTree = mockScopeTree();
const scopedButtons = collectTitleScopeTransportButtons(scopeTree.doc, {
  isShown: (btn) => btn.shown,
});
assert.deepStrictEqual(
  scopedButtons,
  [scopeTree.visiblePlay],
  "title-scope walk should keep climbing past hidden-only transport controls"
);

function mockButtonInTree(opts) {
  return mockButton(opts);
}

function mockDocWithDecoyLabelledPlay() {
  const realPlay = mockButtonInTree({ label: "Play", pause: false, shown: true });
  const decoyPlay = mockButtonInTree({
    label: "Playbar: Play",
    pause: false,
    shown: true,
    rect: { height: 40, width: 40, top: 0, bottom: 40 },
  });

  const innerScope = {
    parentElement: null,
    getBoundingClientRect: () => ({ height: 72 }),
    querySelectorAll(sel) {
      if (sel === "button[aria-label]") return [realPlay];
      return [];
    },
  };
  const outerScope = {
    parentElement: null,
    getBoundingClientRect: () => ({ height: 72 }),
    querySelectorAll(sel) {
      if (sel === "button[aria-label]") return [realPlay];
      return [];
    },
  };
  innerScope.parentElement = outerScope;

  const titleNode = {
    parentElement: innerScope,
    shown: true,
    getAttribute(name) {
      return name === "aria-label" ? "Playbar: Title" : "";
    },
    getBoundingClientRect: () => ({ height: 24, width: 120, top: 820, bottom: 844 }),
  };

  const doc = {
    querySelectorAll(sel) {
      if (sel === "button[aria-label]") return [decoyPlay, realPlay];
      if (sel === '[aria-label*="Playbar: Title"]') return [titleNode];
      if (sel === 'a[aria-label*="Playbar"][href*="/song/"]') return [];
      return [];
    },
  };

  return { doc, decoyPlay, realPlay, titleNode };
}

const decoyDoc = mockDocWithDecoyLabelledPlay();
const collected = collectPlaybarTransportButtons(decoyDoc.doc, {
  isShown: (btn) => btn.shown,
});
assert.deepStrictEqual(
  collected,
  [decoyDoc.realPlay],
  "with a visible play-bar title, prefer title-scope transport over labelled Playbar shells"
);
assert.strictEqual(
  pickPlaybarTransportButton(collected, false, {
    isShown: (btn) => btn.shown,
    buttonShowsPause: (btn) => btn.pause,
    anchor: decoyDoc.titleNode,
  }),
  decoyDoc.realPlay,
  "One song should click the title-scope Play control, not Playbar: Play decoy"
);

function mockDocWithTwoVisibleTitles() {
  const upperDecoyPlay = mockButton({
    label: "Playbar: Play",
    pause: false,
    shown: true,
    rect: { height: 40, width: 40, top: 40, bottom: 80 },
  });
  const realPlay = mockButton({ label: "Play", pause: false, shown: true, rect: { height: 40, width: 40, top: 800, bottom: 840 } });

  const innerScope = {
    parentElement: null,
    getBoundingClientRect: () => ({ height: 72 }),
    querySelectorAll(sel) {
      if (sel === "button[aria-label]") return [realPlay];
      return [];
    },
  };
  innerScope.parentElement = innerScope;

  const upperTitle = {
    parentElement: innerScope,
    shown: true,
    getAttribute(name) {
      return name === "aria-label" ? "Playbar: Title" : "";
    },
    getBoundingClientRect: () => ({ height: 24, width: 120, top: 20, bottom: 44 }),
  };
  const lowerTitle = {
    parentElement: innerScope,
    shown: true,
    getAttribute(name) {
      return name === "aria-label" ? "Playbar: Title for My Song" : "";
    },
    getBoundingClientRect: () => ({ height: 24, width: 120, top: 820, bottom: 844 }),
  };

  const doc = {
    querySelectorAll(sel) {
      if (sel === "button[aria-label]") return [upperDecoyPlay, realPlay];
      if (sel === '[aria-label*="Playbar: Title"]') return [upperTitle, lowerTitle];
      if (sel === 'a[aria-label*="Playbar"][href*="/song/"]') return [];
      return [];
    },
  };

  return { doc, realPlay, lowerTitle };
}

const twoTitles = mockDocWithTwoVisibleTitles();
const collectedFromBottomBar = collectPlaybarTransportButtons(twoTitles.doc, {
  isShown: (btn) => btn.shown,
});
assert.deepStrictEqual(
  collectedFromBottomBar,
  [twoTitles.realPlay],
  "anchor the bottom-most visible play-bar title, not an upper shell"
);

console.log("playbar_transport_picker ok");
