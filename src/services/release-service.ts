import { Store } from '../store/store.js';

export class MaintenanceReleaseService {
  constructor(private readonly store: Store) {}

  release(workOrderId: string): void {
    this.store.lock.runExclusive(() => {
      const order = this.store.workOrders.get(workOrderId);
      if (!order) throw new Error('work order not found');
      const tasks = [...this.store.taskCards.values()].filter((task) => task.workOrderId === workOrderId);
      const completed = tasks.filter((task) => task.status === 'COMPLETED' || task.status === 'WAIVED').length;
      // BUG: task count is used as the release gate; required inspections and signatures are ignored.
      if (completed < tasks.length) throw new Error('required maintenance tasks are incomplete');
      order.status = 'CLOSED';
      order.version += 1;
      this.store.addAudit(order.tenantId, 'work-order.released', 'work-order', order.id, { completedTasks: completed });
      this.store.addOutbox(order.tenantId, 'mro.work-order-released', order.id, { workOrderId });
    });
  }
}
