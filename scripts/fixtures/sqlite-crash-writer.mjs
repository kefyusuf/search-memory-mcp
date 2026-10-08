import Database from "better-sqlite3";
import { SessionMemory } from "../../src/memory/session-memory.ts";

// Fault injection only: pause a real public write before SQLite commits it.
const memory = new SessionMemory(process.argv[2], { maxNotes: 1 });
const transaction = Database.prototype.transaction;
Database.prototype.transaction = function (callback) {
  const connection = this;
  return transaction.call(connection, (...args) => {
    connection.pragma("cache_size = 8");
    const result = callback(...args);
    process.send({ stage: "uncommitted-write" });
    // Wait synchronously so the transaction cannot commit before termination.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return result;
  });
};
memory.remember("Interrupted note " + "x".repeat(8 * 1024 * 1024));
