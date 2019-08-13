import {
  mcdMaker,
  setupCollateral,
  takeSnapshot,
  restoreSnapshot
} from './helpers';
import {
  setMethod,
  transferToBag,
  ensureBag,
  getBagAddress
} from '../src/CdpManager';
import { ServiceRoles } from '../src/constants';
import { ETH, MDAI, GNT, DGD } from '../src';
import { dummyEventData, formattedDummyEventData } from './fixtures';

import TestAccountProvider from 'test-helpers/src/TestAccountProvider';

let maker, cdpMgr, txMgr, snapshotData;

beforeAll(async () => {
  maker = await mcdMaker();
  cdpMgr = maker.service(ServiceRoles.CDP_MANAGER);
  txMgr = maker.service('transactionManager');
  snapshotData = await takeSnapshot(maker);
});

afterAll(async () => {
  await restoreSnapshot(snapshotData, maker);
});

test('getCdpIds gets empty CDP data from a proxy', async () => {
  const currentProxy = await maker.currentProxy();
  const cdps = await cdpMgr.getCdpIds(currentProxy);

  expect(cdps.length).toEqual(0);
});

test('getCdpIds gets all CDP data from the proxy', async () => {
  const cdp1 = await cdpMgr.open('ETH-A');
  const cdp2 = await cdpMgr.open('ETH-B');
  cdpMgr.reset();
  const currentProxy = await maker.currentProxy();
  const cdps = await cdpMgr.getCdpIds(currentProxy);

  expect(cdps.length).toEqual(2);
  expect(cdps).toContainEqual({ id: cdp1.id, ilk: cdp1.ilk });
  expect(cdps).toContainEqual({ id: cdp2.id, ilk: cdp2.ilk });
});

test('getCombinedDebtValue', async () => {
  await setupCollateral(maker, 'ETH-A', { price: 150, debtCeiling: 50 });
  await cdpMgr.openLockAndDraw('ETH-A', ETH(1), MDAI(3));
  await cdpMgr.openLockAndDraw('ETH-A', ETH(2), MDAI(5));
  cdpMgr.reset();
  const currentProxy = await maker.currentProxy();
  const totalDebt = await cdpMgr.getCombinedDebtValue(currentProxy);
  expect(totalDebt).toEqual(MDAI(8));
});

test('getCdp looks up ilk', async () => {
  const cdp = await cdpMgr.open('ETH-A');
  const sameCdp = await cdpMgr.getCdp(cdp.id);
  expect(sameCdp.ilk).toEqual(cdp.ilk);
});

test('getCombinedEventHistory', async () => {
  const proxy = await maker.currentProxy();
  const mockFn = jest.fn(async () => dummyEventData('ETH-A'));
  maker.service(
    ServiceRoles.QUERY_API
  ).getCdpEventsForArrayOfIlksAndUrns = mockFn;
  const events = await cdpMgr.getCombinedEventHistory(proxy);
  expect(mockFn).toBeCalled();
  const GEM = maker
    .service(ServiceRoles.CDP_TYPE)
    .getCdpType(null, events[0].ilk).currency;
  expect(events).toEqual(formattedDummyEventData(GEM, events[0].ilk));
});

test('transaction tracking for openLockAndDraw', async () => {
  const cdpMgr = maker.service(ServiceRoles.CDP_MANAGER);
  const txMgr = maker.service('transactionManager');
  const open = cdpMgr.openLockAndDraw('ETH-A', ETH(1), MDAI(0));
  expect.assertions(5);
  const handlers = {
    pending: jest.fn(({ metadata: { contract, method } }) => {
      expect(contract).toBe('PROXY_ACTIONS');
      expect(method).toBe('openLockETHAndDraw');
    }),
    mined: jest.fn(tx => {
      expect(tx.hash).toBeTruthy();
    })
  };
  txMgr.listen(open, handlers);
  await open;
  expect(handlers.pending).toBeCalled();
  expect(handlers.mined).toBeCalled();
});

test('set precision arguments according to decimals', () => {
  expect(cdpMgr._precision(ETH(1))).toBe('wei');
  expect(cdpMgr._precision(GNT(1))).toBe(18);
  expect(cdpMgr._precision(DGD(1))).toBe(9);
});

test('set method correctly', () => {
  expect(setMethod(true, 1)).toBe('lockETHAndDraw');
  expect(setMethod(true)).toBe('openLockETHAndDraw');
  expect(setMethod(false, 1)).toBe(
    'lockGemAndDraw(address,address,address,uint256,uint256,uint256,bool)'
  );
  expect(setMethod()).toBe('openLockGemAndDraw');
});

describe('GNT-specific functionality', () => {
  let proxyAddress, gntAdapter;

  beforeAll(async () => {
    proxyAddress = await maker.service('proxy').ensureProxy();
    gntAdapter = maker.service('smartContract').getContract('MCD_JOIN_GNT_A');
  });

  test('getBagAddress returns null when no bag exists', async () => {
    expect(await getBagAddress(proxyAddress, gntAdapter)).toBeNull();
  });

  test('ensureBag creates a bag when none exists', async () => {
    const bagAddressBeforeEnsure = await getBagAddress(
      proxyAddress,
      gntAdapter
    );
    const bagAddress = await ensureBag(proxyAddress, cdpMgr);

    expect(bagAddressBeforeEnsure).toBeNull();
    expect(bagAddress).toMatch(/^0x[A-Fa-f0-9]{40}$/);
  });

  test('getBagAddress returns real address when one exists', async () => {
    expect(await ensureBag(proxyAddress, cdpMgr)).toMatch(
      /^0x[A-Fa-f0-9]{40}$/
    );
  });

  test('transferToBag transfers...to bag', async () => {
    const gntToken = maker.service('token').getToken(GNT);
    const bagAddress = await ensureBag(proxyAddress, cdpMgr);

    const startingBalance = await gntToken.balanceOf(bagAddress);
    await transferToBag(GNT(1), proxyAddress, cdpMgr);
    const endingBalance = await gntToken.balanceOf(bagAddress);

    expect(startingBalance.toNumber()).toEqual(0);
    expect(endingBalance.toNumber()).toEqual(1);
  });
});

describe('using a different account', () => {
  let mgr, cdpId;

  beforeAll(async () => {
    const account2 = TestAccountProvider.nextAccount();
    await maker.addAccount({ ...account2, type: 'privateKey' });
    maker.useAccount(account2.address);
    mgr = maker.service(ServiceRoles.CDP_MANAGER);
  });

  afterAll(() => {
    maker.useAccount('default');
  });

  test('create proxy during open', async () => {
    expect(await maker.currentProxy()).toBeFalsy();
    const open = mgr.openLockAndDraw('ETH-A', ETH(2));

    const handler = jest.fn((tx, state) => {
      const label = tx.metadata.contract + '.' + tx.metadata.method;
      switch (handler.mock.calls.length) {
        case 1:
          expect(state).toBe('pending');
          expect(label).toBe('PROXY_REGISTRY.build');
          break;
        case 2:
          expect(state).toBe('mined');
          expect(label).toBe('PROXY_REGISTRY.build');
          break;
        case 3:
          expect(state).toBe('pending');
          expect(label).toBe('PROXY_ACTIONS.openLockETHAndDraw');
          break;
        case 4:
          expect(state).toBe('mined');
          expect(label).toBe('PROXY_ACTIONS.openLockETHAndDraw');
          break;
      }
    });
    txMgr.listen(open, handler);
    const cdp = await open;
    expect(handler.mock.calls.length).toBe(4);
    expect(cdp.id).toBeGreaterThan(0);
    cdpId = cdp.id;
    expect(await maker.currentProxy()).toBeTruthy();
  });

  test("prevent access to a CDP you don't own", async () => {
    maker.useAccount('default');
    const cdp = await mgr.getCdp(cdpId);
    expect.assertions(1);
    try {
      await cdp.freeCollateral(ETH(1));
    } catch (err) {
      expect(err.message).toMatch(/revert/);
    }
  });
});