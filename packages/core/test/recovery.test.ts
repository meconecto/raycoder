import { describe, expect, it } from "vitest";
import { createTicket } from "../src/domain.js";
import { RecoveryService } from "../src/recovery.js";
import { TicketRepository } from "../src/ticket-repository.js";

describe("bootstrap recovery", () => {
  it.each(["RUNNING", "REVIEW", "READY_TO_MERGE"] as const)(
    "reclassifies persisted %s to INTERRUPTED after an uncontrolled stop",
    async (target) => {
      const repository = new TicketRepository(":memory:");
      repository.create(
        createTicket({
          id: target.toLowerCase(),
          title: target,
          description: "test",
          baseBranch: "main",
          hasPredecessors: false,
        }),
      );
      repository.transition(target.toLowerCase(), "RUNNING", "test");
      if (target === "REVIEW" || target === "READY_TO_MERGE") {
        repository.transition(target.toLowerCase(), "REVIEW", "test");
      }
      if (target === "READY_TO_MERGE") {
        repository.transition(target.toLowerCase(), "READY_TO_MERGE", "test");
      }

      const recovered = await new RecoveryService(repository).recoverUncontrolledShutdown();
      expect(recovered).toHaveLength(1);
      expect(repository.get(target.toLowerCase()).status).toBe("INTERRUPTED");
      expect(repository.history(target.toLowerCase()).at(-1)?.reason).toBe("bootstrap_uncontrolled_shutdown");
      repository.close();
    },
  );
});
