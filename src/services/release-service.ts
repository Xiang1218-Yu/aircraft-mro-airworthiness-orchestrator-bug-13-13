import type { MaintenanceReleaseResult, PartStock, Reservation, WorkOrder, WorkOrderStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

export class MaintenanceReleaseService {
  constructor(private readonly store: Store) {}

  async release(workOrderId: string): Promise<MaintenanceReleaseResult> {
    return this.store.lock.runExclusive(() => {
      const order = this.store.workOrders.get(workOrderId);
      if (!order) throw new Error('work order not found');

      // Idempotency: a repeated release returns the existing outcome and never
      // re-triggers stock issue, customer notification, audit or outbox writes.
      const existing = this.store.maintenanceReleases.get(workOrderId);
      if (existing) {
        return {
          workOrderId,
          releasedAt: existing.releasedAt,
          duplicate: true,
          issuedReservationIds: existing.issuedReservationIds,
        };
      }
      // Defence in depth: a CLOSED order must carry its release record; a
      // CANCELLED order can never be released.
      if (order.status === 'CLOSED') throw new Error('work order already closed');
      if (order.status === 'CANCELLED') throw new Error('work order is cancelled');

      const tasks = [...this.store.taskCards.values()].filter((task) => task.workOrderId === workOrderId);
      const inspections = [...this.store.inspections.values()].filter((inspection) => inspection.workOrderId === workOrderId);
      const signatures = [...this.store.airworthinessSignatures.values()].filter((signature) => signature.workOrderId === workOrderId);

      // Gate 1: every required task card must be COMPLETED. A WAIVED card is
      // not required, otherwise it cannot be waived past the gate.
      const pendingRequiredTasks = tasks.filter((task) => task.required && task.status !== 'COMPLETED');
      if (pendingRequiredTasks.length > 0) {
        throw new Error(`required maintenance tasks are incomplete: ${pendingRequiredTasks.map((task) => task.id).join(', ')}`);
      }

      // Gate 2: every mandatory independent inspection must be PASSED.
      const failedInspections = inspections.filter((inspection) => inspection.required && inspection.status === 'FAILED');
      if (failedInspections.length > 0) {
        throw new Error(`required independent inspections failed: ${failedInspections.map((inspection) => inspection.id).join(', ')}`);
      }
      const pendingInspections = inspections.filter((inspection) => inspection.required && inspection.status !== 'PASSED');
      if (pendingInspections.length > 0) {
        throw new Error(`required independent inspections are pending: ${pendingInspections.map((inspection) => inspection.id).join(', ')}`);
      }

      // Gate 3: a currently valid airworthiness signature must exist.
      const now = Date.now();
      const hasValidSignature = signatures.some(
        (signature) => signature.valid && !Number.isNaN(Date.parse(signature.signedAt)) && Date.parse(signature.signedAt) <= now,
      );
      if (!hasValidSignature) throw new Error('no current valid airworthiness signature');

      // Gate 4: release is only legal from COMPLETED (matches the work-order
      // state machine). All checks above are pure reads: nothing has mutated.
      if (order.status !== 'COMPLETED') throw new Error(`work order is not ready for release: ${order.status}`);

      const toIssue = order.reservations.flatMap((reservationId) => {
        const reservation = this.store.reservations.get(reservationId);
        if (!reservation || reservation.status !== 'ACTIVE') return [];
        const stock = this.store.stocks.get(reservation.stockId);
        if (!stock) throw new Error(`stock missing for reservation ${reservationId}`);
        if (stock.qualityStatus !== 'RELEASED') throw new Error(`stock ${stock.id} is not releasable`);
        if (stock.quantity - stock.reserved < 0) throw new Error(`stock ${stock.id} is unavailable`);
        return [{ reservation, stock }];
      });

      // Commit phase: state transition, stock issue, audit, release record and
      // outbox messages are applied together. Any failure runs rollback so no
      // partial state / audit / outbox is left behind.
      const issuedReservationIds: string[] = [];
      const rollback = this.prepareRollback(order, toIssue.map((item) => item.reservation), toIssue.map((item) => item.stock));
      try {
        for (const { reservation, stock } of toIssue) {
          stock.quantity -= reservation.quantity;
          stock.reserved -= reservation.quantity;
          stock.version += 1;
          reservation.status = 'ISSUED';
          reservation.version += 1;
          issuedReservationIds.push(reservation.id);
          this.store.addAudit(order.tenantId, 'inventory.issued', 'reservation', reservation.id, {
            stockId: stock.id,
            quantity: reservation.quantity,
            reason: 'work-order-release',
          });
          this.store.addOutbox(order.tenantId, 'mro.stock-issued', order.id, {
            reservationId: reservation.id,
            stockId: stock.id,
            workOrderId,
          });
        }

        order.status = 'CLOSED';
        order.version += 1;
        const releasedAt = this.store.now();

        this.store.addAudit(order.tenantId, 'work-order.released', 'work-order', order.id, {
          issuedReservations: issuedReservationIds.length,
        });
        this.store.addOutbox(order.tenantId, 'mro.work-order-released', order.id, {
          workOrderId,
          issuedReservationIds,
          releasedAt,
        });
        // Customer notification rides its own outbox event; because a repeated
        // release short-circuits above, the customer is never notified twice.
        this.store.addOutbox(order.tenantId, 'mro.customer-release-notification', order.id, {
          workOrderId,
          releasedAt,
        });

        this.store.maintenanceReleases.set(order.id, {
          workOrderId,
          tenantId: order.tenantId,
          releasedAt,
          workOrderVersion: order.version,
          issuedReservationIds,
        });

        return { workOrderId, releasedAt, duplicate: false, issuedReservationIds };
      } catch (error) {
        rollback();
        throw error;
      }
    });
  }

  private prepareRollback(order: WorkOrder, reservations: Reservation[], stocks: PartStock[]): () => void {
    const orderStatus: WorkOrderStatus = order.status;
    const orderVersion = order.version;
    const reservationStates = reservations.map((reservation) => ({ reservation, status: reservation.status, version: reservation.version }));
    const stockStates = stocks.map((stock) => ({ stock, quantity: stock.quantity, reserved: stock.reserved, version: stock.version }));
    const outboxLength = this.store.outbox.length;
    const auditLength = this.store.audit.length;
    // The record cannot already exist: idempotency check above would have returned.
    return () => {
      this.store.outbox.length = outboxLength;
      this.store.audit.length = auditLength;
      this.store.maintenanceReleases.delete(order.id);
      for (const state of stockStates) {
        state.stock.quantity = state.quantity;
        state.stock.reserved = state.reserved;
        state.stock.version = state.version;
      }
      for (const state of reservationStates) {
        state.reservation.status = state.status;
        state.reservation.version = state.version;
      }
      order.status = orderStatus;
      order.version = orderVersion;
    };
  }
}
