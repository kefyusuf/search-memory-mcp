import { Client } from "pg";

// Exercise the real fixture cleanup with a slower external-driver shutdown.
// Pool.end may finish its bookkeeping before the server connection closes.
const originalEnd = Client.prototype.end;
Client.prototype.end = function (...args) {
  if (typeof args[0] === "function") {
    setTimeout(() => originalEnd.apply(this, args), 100);
    return;
  }
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { Promise.resolve(originalEnd.apply(this, args)).then(resolve, reject); }
      catch (error) { reject(error); }
    }, 100);
  });
};

try {
  await import("./verify-membership-postgres.mjs");
  console.log("PostgreSQL delayed-connection shutdown verification passed");
} finally {
  Client.prototype.end = originalEnd;
}
