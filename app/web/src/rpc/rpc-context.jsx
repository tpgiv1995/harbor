import React, { createContext, useContext } from 'react';

const RpcContext = createContext(null);

export function RpcProvider({ client, children }) {
  return (
    <RpcContext.Provider value={client}>
      {children}
    </RpcContext.Provider>
  );
}

export function useRpc() {
  const client = useContext(RpcContext);
  if (!client) {
    throw new Error('useRpc must be used within RpcProvider');
  }
  return client;
}

export function useOptionalRpc() {
  return useContext(RpcContext);
}
