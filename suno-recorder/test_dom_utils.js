const assert = require("assert");
const { isShown } = require("./dom_utils.js");

const viewportRect = { width: 48, height: 48, top: 100, bottom: 148, left: 0, right: 48 };

function mockEl(computedStyle) {
  return {
    getBoundingClientRect() {
      return viewportRect;
    },
    nodeType: 1,
    __style: computedStyle,
  };
}

global.window = {
  innerHeight: 900,
  getComputedStyle(el) {
    return el.__style || {};
  },
};

assert.strictEqual(isShown(mockEl({ display: "block", visibility: "visible", opacity: "1" })), true);
assert.strictEqual(isShown(mockEl({ display: "none", visibility: "visible", opacity: "1" })), false);
assert.strictEqual(isShown(mockEl({ display: "block", visibility: "hidden", opacity: "1" })), false);
assert.strictEqual(isShown(mockEl({ display: "block", visibility: "visible", opacity: "0" })), false);

console.log("dom_utils ok");
