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

  it("finishes an APPLYING integration when Git evidence proves the target is on the base", async () => {
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({
      id: "parent",
      title: "parent",
      description: "test",
      baseBranch: "main",
      hasPredecessors: false,
    }));
    repository.create(createTicket({
      id: "child",
      title: "child",
      description: "test",
      baseBranch: "main",
      hasPredecessors: true,
    }), ["parent"]);
    repository.transition("parent", "RUNNING", "test");
    repository.transition("parent", "REVIEW", "test");
    repository.transition("parent", "READY_TO_MERGE", "test");
    repository.createIntegrationAttempt({
      id: "attempt",
      ticketId: "parent",
      mode: "auto",
      originalBaseCommit: "base",
      ticketHead: "ticket",
    });
    repository.updateIntegrationAttempt("attempt", {
      status: "APPLYING",
      observedBaseHead: "base",
      targetCommit: "target",
      verificationStatus: "SKIPPED",
    });

    const recovered = await new RecoveryService(repository, undefined, {
      async isTargetIntegrated() { return true; },
    }).recoverUncontrolledShutdown();

    expect(recovered[0]?.ticket.status).toBe("DONE");
    expect(repository.get("child").status).toBe("READY");
    expect(repository.history("parent").slice(-2).map((entry) => entry.toStatus)).toEqual(["INTERRUPTED", "DONE"]);
    expect(repository.getIntegrationAttempt("attempt").status).toBe("INTEGRATED");
    repository.close();
  });

  it("keeps an APPLYING integration interrupted without Git evidence", async () => {
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({
      id: "ticket",
      title: "ticket",
      description: "test",
      baseBranch: "main",
      hasPredecessors: false,
    }));
    repository.transition("ticket", "RUNNING", "test");
    repository.transition("ticket", "REVIEW", "test");
    repository.transition("ticket", "READY_TO_MERGE", "test");
    repository.createIntegrationAttempt({
      id: "attempt",
      ticketId: "ticket",
      mode: "auto",
      originalBaseCommit: "base",
      ticketHead: "ticket",
    });
    repository.updateIntegrationAttempt("attempt", {
      status: "APPLYING",
      observedBaseHead: "base",
      targetCommit: "target",
      verificationStatus: "SKIPPED",
    });

    await new RecoveryService(repository, undefined, {
      async isTargetIntegrated() { return false; },
    }).recoverUncontrolledShutdown();

    expect(repository.get("ticket").status).toBe("INTERRUPTED");
    expect(repository.getIntegrationAttempt("attempt").status).toBe("INTERRUPTED");
    repository.close();
  });
});
