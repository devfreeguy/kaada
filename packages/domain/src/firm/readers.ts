/** READ-ONLY: the current ERC-20 allowance an owner has granted a spender. Never writes or signs. */
export interface AllowanceReader {
  readAllowance(input: {
    chainId: number;
    token: string;
    owner: string;
    spender: string;
  }): Promise<bigint>;
}
