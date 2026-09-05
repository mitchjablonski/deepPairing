import { ReviewPostJournal, type ReviewPostIdentity } from "../../review-post-journal.js";
import { writeJsonAtomic } from "../../atomic-write.js";

const journal = new ReviewPostJournal(process.argv[2], process.argv[3], (file, value) => {
  if (process.argv[4] === "hold") {
    process.send?.({ type: "claimed" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  }
  writeJsonAtomic(file, value);
});
process.on("message", (identity: ReviewPostIdentity) => {
  try {
    journal.reserve(identity);
    process.send?.({ type: "reserved" });
  } catch (err) {
    process.send?.({ type: "refused", reason: String(err) });
  }
});
process.send?.({ type: "ready" });
