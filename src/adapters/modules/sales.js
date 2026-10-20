export function createSalesAdapter(salesService) {
  return {
    create(tx, input) {
      return salesService.createInTx(tx, input);
    },
  };
}
