import { afterEach, beforeEach, describe, test } from "vite-plus/test";
import { IndexedDbEventStore, MemoryEventStore } from "../src/index.ts";
import { eventStoreConformanceCases } from "../src/testing/index.ts";
import { installIdbMock, type IdbMock } from "./helpers/idb-mock.ts";

describe("MemoryEventStore conformance", () => {
  for (const c of eventStoreConformanceCases) {
    test(c.name, () => c.run(new MemoryEventStore()));
  }
});

describe("IndexedDbEventStore conformance", () => {
  let mock: IdbMock;
  let dbSeq = 0;

  beforeEach(() => {
    mock = installIdbMock();
  });

  afterEach(() => {
    mock.uninstall();
  });

  for (const c of eventStoreConformanceCases) {
    test(c.name, async () => {
      const store = new IndexedDbEventStore({ dbName: `conformance-${dbSeq++}` });
      await store.open();
      try {
        await c.run(store);
      } finally {
        store.close();
      }
    });
  }
});
