// v1.49 polish proof: the header model chip's short label.
import { readFileSync } from "node:fs";
const src = readFileSync(
  process.env.HOME + "/workspace/ghost-ide/web/src/main.js", "utf8");
const block = src.split("/*@@CHIP@@*/")[1]
  .split("/*@@CHIP-END@@*/")[0];
const { shortModelLabel } = new Function("window", block +
  "; return { shortModelLabel };")({});
let passed = 0, failed = 0;
const ck = (name, got, want) => {
  const ok = got === want;
  console.log((ok ? "PASS " : "FAIL ") + name +
    (ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
  ok ? passed++ : failed++;
};
ck("desktop 7B gguf name", shortModelLabel("qwen2.5-coder-7b-instruct-q4_k_m"), "7B · on-device");
ck("phone 1.5B name", shortModelLabel("Qwen2.5-Coder-1.5B-Instruct"), "1.5B · on-device");
ck("sprinter 0.5B", shortModelLabel("Qwen2.5-Coder 0.5B Sprinter"), "0.5B · on-device");
ck("3B with space", shortModelLabel("Qwen2.5-Coder 3B"), "3B · on-device");
ck("Qwen version digits are not a size", shortModelLabel("Qwen2.5-Coder-7B"), "7B · on-device");
ck("unknown name passes through", shortModelLabel("custom-model"), "custom-model");
ck("long unknown name truncates", shortModelLabel("a-very-long-custom-model-name-x").length, 20);
ck("empty name falls back", shortModelLabel(""), "model");
ck("null name falls back", shortModelLabel(null), "model");
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
