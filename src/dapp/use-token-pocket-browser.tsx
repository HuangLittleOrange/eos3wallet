import React, { useCallback, useRef, useState } from 'react';
import { Alert, Share } from 'react-native';

import type { ChainClient } from '../chain/client';
import DappScanModal from '../components/DappScanModal';
import { useI18n } from '../i18n';
import { dappDeviceId } from './dappDeviceId';
import { isDappFavorite, toggleDappFavorite } from './dappGate';
import { SaveImageError, saveRemoteImage } from './saveRemoteImage';

type Request = { id: string; method: string; params?: any };
type Options = {
  client: Pick<ChainClient, 'getActions'>;
  account: string;
  url: string;
  pageUrl: string;
  reply: (id: string, ok: boolean, payload: any) => void;
  goBack: () => void;
  close: () => void;
  importWallet: () => Promise<void>;
  onFavorited: () => void;
};

/** Native TP page actions only. Identity, signing and chain safety stay in the
 * shared wallet bridge. Call handleRequest only after native access validation.
 */
export function useTokenPocketBrowser(options: Options) {
  const { t } = useI18n();
  const latest = useRef({ ...options, t });
  latest.current = { ...options, t };
  const [scanRequestId, setScanRequestId] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [menubarInFullScreen, setMenubarInFullScreen] = useState(false);
  const [navGestures, setNavGestures] = useState(false);
  const cancelScan = useCallback(() => setScanRequestId(null), []);

  const handleRequest = useCallback((request: Request): boolean => {
    const opts = latest.current;
    const p = request.params ?? {};
    const reply = (ok: boolean, payload: unknown) => opts.reply(request.id, ok, payload);
    const fail = (error: any) => reply(false, String(error?.message ?? error));
    let host = opts.pageUrl;
    try { host = new URL(opts.pageUrl).host; } catch {}

    switch (request.method) {
      case 'getDeviceId':
        dappDeviceId(host || opts.url).then((id) => reply(true, id), fail);
        return true;
      case 'getActions': {
        const limit = Math.min(Math.max(Number(p.count) || 10, 1), 100);
        const skip = Math.max(Number(p.start) || 0, 0);
        opts.client.getActions(String(p.account ?? opts.account), { limit, skip }).then((page) => {
          let list = page.actions;
          if (p.contract) list = list.filter((action) => action.contract === p.contract);
          if (p.token) list = list.filter((action) => (action.quantity ?? '').endsWith(` ${p.token}`));
          if (p.sort === 'asc') list = [...list].reverse();
          reply(true, list);
        }, fail);
        return true;
      }
      case 'scanQR':
        setScanRequestId(request.id);
        return true;
      case 'share': {
        const message = [p.title, p.description, p.url].filter(Boolean).join('\n');
        Share.share({ title: p.title, message, url: p.url }).then(() => reply(true, true), fail);
        return true;
      }
      case 'goBack':
        opts.goBack();
        reply(true, true);
        return true;
      case 'closeBrowser':
        reply(true, true);
        opts.close();
        return true;
      case 'fullScreen':
        setFullScreen(!!p.on);
        if (!p.on) setMenubarInFullScreen(false);
        reply(true, true);
        return true;
      case 'setMenubar':
        setMenubarInFullScreen(!!p.visible);
        reply(true, true);
        return true;
      // The page can open the native import UI; it never receives its secret input.
      case 'importWallet':
        reply(true, true);
        void opts.importWallet();
        return true;
      case 'saveImage':
        saveRemoteImage(String(p.url ?? '')).then(() => {
          reply(true, true);
          Alert.alert(opts.t('dappBrowser.imageSaved'));
        }, (error) => {
          fail(error);
          Alert.alert(opts.t(error instanceof SaveImageError && error.message === 'permission-denied'
            ? 'dappBrowser.imagePermissionDenied' : 'dappBrowser.imageSaveFailed'));
        });
        return true;
      case 'setNavGestures':
        setNavGestures(!!p.enabled);
        reply(true, true);
        return true;
      case 'addFavorite': {
        const target = String(p.url ?? opts.url);
        isDappFavorite(target).then((already) => already ? true : toggleDappFavorite(target, String(p.name ?? host)))
          .then(() => {
            if (target === opts.url) opts.onFavorited();
            reply(true, true);
          }, fail);
        return true;
      }
      default:
        return false;
    }
  }, []);

  return {
    handleRequest, cancelScan, fullScreen, menubarInFullScreen, navGestures,
    scanElement: (
      <DappScanModal
        visible={scanRequestId !== null}
        onResult={(text) => {
          if (scanRequestId) options.reply(scanRequestId, true, text);
          cancelScan();
        }}
        onCancel={() => {
          if (scanRequestId) options.reply(scanRequestId, false, t('dappBrowser.userRejected'));
          cancelScan();
        }}
      />
    ),
  };
}
