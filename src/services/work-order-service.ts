import type { WorkOrder, WorkOrderEvent, WorkOrderStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

const transitions: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  OPEN: ['MATERIALS_RESERVED', 'CANCELLED'],
  MATERIALS_RESERVED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PAUSED' as WorkOrderStatus, 'COMPLETED', 'CANCELLED'],
  PAUSED: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export class WorkOrderService {
  constructor(private readonly store: Store) {}

  async applyEvent(workOrderId: string, event: WorkOrderEvent): Promise<WorkOrderStatus> {
    return this.store.transact(() => {
      const workOrder = this.store.workOrders.get(workOrderId);
      if (!workOrder) throw new Error('work order not found');

      const lastSequence = workOrder.lastEventSequence[event.source] ?? -1;
      // Idempotent against both replays (per-source sequence) and retries (event id).
      if (event.sequence <= lastSequence || workOrder.processedEventIds.includes(event.id)) {
        return workOrder.status;
      }

      const from = workOrder.status;
      const fromVersion = workOrder.version;
      const hadSequence = Object.prototype.hasOwnProperty.call(workOrder.lastEventSequence, event.source);
      const fromSequence = lastSequence;
      const fromProcessed = workOrder.processedEventIds.length;
      const next = this.mapEvent(event.type);

      const rollback = (): void => {
        workOrder.status = from;
        workOrder.version = fromVersion;
        if (hadSequence) {
          workOrder.lastEventSequence[event.source] = fromSequence;
        } else {
          delete workOrder.lastEventSequence[event.source];
        }
        workOrder.processedEventIds.length = fromProcessed;
      };

      try {
        workOrder.lastEventSequence[event.source] = event.sequence;
        workOrder.processedEventIds.push(event.id);

        if (!transitions[from].includes(next)) {
          this.store.addAudit(workOrder.tenantId, 'work-order.invalid-event', 'work-order', workOrder.id, {
            eventType: event.type,
            current: from,
          });
          return from;
        }

        workOrder.status = next;
        workOrder.version += 1;
        this.store.addAudit(workOrder.tenantId, 'work-order.status-changed', 'work-order', workOrder.id, {
          from,
          to: next,
          sequence: event.sequence,
        });
        this.store.addOutbox(workOrder.tenantId, 'mro.work-order-status', workOrder.id, {
          workOrderId,
          status: next,
          eventId: event.id,
        });
        return next;
      } catch (error) {
        rollback();
        throw error;
      }
    });
  }

  private mapEvent(type: WorkOrderEvent['type']): WorkOrderStatus {
    if (type === 'STARTED') return 'IN_PROGRESS';
    if (type === 'PAUSED') return 'PAUSED';
    if (type === 'COMPLETED') return 'COMPLETED';
    if (type === 'CLOSED') return 'CLOSED';
    return 'CANCELLED';
  }
}
