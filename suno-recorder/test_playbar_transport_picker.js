const assert = require("assert");
const {
  pickPlaybarTransportButton,
  collectTitleScopeTransportButtons,
} = require("./playbar_transport_picker.js");

function mockButton({ label, pause, shown = true }) {
  return {
    shown,
    getAttribute(name) {
      return name === "aria-label" ? label : "";
    },
    pause,
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

console.log("playbar_transport_picker ok");
