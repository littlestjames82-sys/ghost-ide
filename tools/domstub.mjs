function makeEl() {
  return {
    children: [], style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    appendChild(c){ return c; }, removeChild(){},
    addEventListener(){}, removeEventListener(){},
    setAttribute(){}, getAttribute(){ return null; },
    querySelector(){ return makeEl(); }, querySelectorAll(){ return []; },
    getBoundingClientRect(){ return { x:0, y:0, top:0, left:0, bottom:0, right:0, width:0, height:0 }; },
    focus(){}, blur(){}, remove(){},
  };
}
globalThis.document = {
  getElementById: () => makeEl(),
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  querySelector: () => makeEl(),
  addEventListener(){},
  body: makeEl(), documentElement: makeEl(), head: makeEl(),
  createRange: () => ({ setStart(){}, setEnd(){}, collapse(){},
    getBoundingClientRect(){ return { top:0, left:0, bottom:0, right:0, width:0, height:0 }; },
    getClientRects(){ return []; } }),
};
globalThis.window = globalThis;
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-stub", maxTouchPoints: 0 }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
globalThis.fetch = () => new Promise(() => {});
globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
globalThis.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
globalThis.MutationObserver = class { observe(){} disconnect(){} takeRecords(){ return []; } };
globalThis.matchMedia = () => ({ matches: false, addEventListener(){}, addListener(){} });
globalThis.scrollTo = () => {};
globalThis.HTMLElement = class {};
globalThis.Element = class {};
globalThis.Node = class {};
class Ev { constructor(t, o){ this.type = t; if (o) Object.assign(this, o); } }
globalThis.Event = Ev;
globalThis.CustomEvent = Ev;
globalThis.KeyboardEvent = class extends Ev {};
globalThis.MouseEvent = class extends Ev {};
