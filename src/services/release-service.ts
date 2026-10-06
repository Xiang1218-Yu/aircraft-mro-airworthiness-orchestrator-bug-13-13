import type { ReleaseResult, WorkOrder } from '../domain/types.js';
import { Store } from '../store/store.js';

const RELEASE_TOPIC = 'mro.work-order-released';

export class MaintenanceReleaseService {
  constructor(private readonly store: Store) {}

  /**
   * Release (close) a maintenance work order. The release gate requires:
   *  - every required task card is COMPLETED or WAIVED;
   *  - every required independent inspection has PASSED;
   *  - a current, valid airworthiness signature exists (a later invalid
   *    signature supersedes an earlier valid one);
   *  - the work order is in COMPLETED state (COMPLETED -> CLOSED only).
   *
   * The whole transition runs in one store transaction: the status change,
   * audit record and Outbox message commit together or not at all. A repeated
   * release (including a concurrent, retried one) is idempotent and returns the
   * result of the original release without emitting another Outbox message, so
   * stock issue and customer notification can never fire twice.
   */
  async release(workOrderId: string): Promise<ReleaseResult> {
    return this.store.transact(() => {
      const order = this.store.workOrders.get(workOrderId);
      if (!order) throw new Error('work order not found');

      // Idempotency: an existing release Outbox message is the durable marker
      // of a completed release. Checked before any mutation and (thanks to the
      // transaction lock) linearised against concurrent releases/retries.
      const prior = this.findReleaseOutbox(workOrderId);
      if (prior) {
        return { workOrderId, status: order.status, outboxId: prior, alreadyReleased: true };
      }

      const reasons = this.evaluateGate(order);
      if (reasons.length > 0) {
        throw new Error(`work order is not releasable: ${reasons.join('; ')}`);
      }

      // Snapshot the aggregate so the status change rolls back together with
      // the audit/Outbox writes if commit fails.
      const fromStatus = order.status;
      const fromVersion = order.version;
      try {
        order.status = 'CLOSED';
        order.version += 1;
        const auditId = this.store.addAudit(
          order.tenantId,
          'work-order.released',
          'work-order',
          order.id,
          { from: fromStatus, to: 'CLOSED' },
        );
        const outboxId = this.store.addOutbox(order.tenantId, RELEASE_TOPIC, order.id, {
          workOrderId,
          auditId,
        });
        return { workOrderId, status: order.status, outboxId, alreadyReleased: false };
      } catch (error) {
        order.status = fromStatus;
        order.version = fromVersion;
        throw error;
      }
    });
  }

  private evaluateGate(order: WorkOrder): string[] {
    const reasons: string[] = [];

    const tasks = [...this.store.taskCards.values()].filter((task) => task.workOrderId === order.id);
    const openRequiredTasks = tasks
      .filter((task) => task.required)
      .filter((task) => task.status !== 'COMPLETED' && task.status !== 'WAIVED');
    if (openRequiredTasks.length > 0) {
      reasons.push(`required task cards are not complete: ${openRequiredTasks.map((task) => task.id).join(', ')}`);
    }

    const inspections = [...this.store.inspections.values()].filter((item) => item.workOrderId === order.id);
    const blockedInspections = inspections.filter((item) => item.required && item.status !== 'PASSED');
    if (blockedInspections.length > 0) {
      reasons.push(
        `mandatory independent inspections are not passed: ${blockedInspections
          .map((item) => `${item.id}=${item.status}`)
          .join(', ')}`,
      );
    }

    const signatures = [...this.store.airworthinessSignatures.values()].filter(
      (signature) => signature.workOrderId === order.id,
    );
    const currentSignature = signatures.sort((left, right) => left.signedAt.localeCompare(right.signedAt)).at(-1);
    if (!currentSignature) {
      reasons.push('no airworthiness signature on record');
    } else if (!currentSignature.valid) {
      reasons.push(`current airworthiness signature ${currentSignature.id} is not valid`);
    }

    if (order.status !== 'COMPLETED') {
      reasons.push(`invalid state transition ${order.status} -> CLOSED (only COMPLETED can be released)`);
    }

    return reasons;
  }

  private findReleaseOutbox(workOrderId: string): string | undefined {
    for (let index = this.store.outbox.length - 1; index >= 0; index -= 1) {
      const message = this.store.outbox[index];
      if (message && message.topic === RELEASE_TOPIC && message.aggregateId === workOrderId) {
        return message.id;
      }
    }
    return undefined;
  }
}
