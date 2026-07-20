// @ts-nocheck
const DATABASE_NAME = "notionQuickNoteOAuthDeviceV1";
const DATABASE_VERSION = 1;
const STORE_NAME = "keys";
const KEY_ID = "device";

let defaultKeyStore;

export function getDefaultOAuthDeviceKeyStore() {
  if (!defaultKeyStore) {
    defaultKeyStore = createOAuthDeviceKeyStore({
      indexedDBImpl: globalThis.indexedDB,
      cryptoImpl: globalThis.crypto,
      allowKeyCreation: !Boolean(globalThis.chrome?.extension?.inIncognitoContext)
    });
  }
  return defaultKeyStore;
}

export function createOAuthDeviceKeyStore({
  indexedDBImpl,
  cryptoImpl = globalThis.crypto,
  allowKeyCreation = true
}) {
  if (!indexedDBImpl) throw deviceUnavailable("Secure device storage is unavailable in this browser.");
  try {
    assertWebCrypto(cryptoImpl);
  } catch (error) {
    throw deviceUnavailable(error.message, error);
  }

  let activeLoad;
  return {
    getOrCreateKeyPair() {
      if (!activeLoad) {
        activeLoad = loadOrCreateKeyPair({ indexedDBImpl, cryptoImpl, allowKeyCreation }).catch((error) => {
          activeLoad = undefined;
          throw error?.code === "oauth_device_unavailable"
            ? error
            : deviceUnavailable("The OAuth device key is unavailable. Reconnect Notion in a regular window.", error);
        });
      }
      return activeLoad;
    }
  };
}

export async function generateOAuthDeviceKeyPair(cryptoImpl = globalThis.crypto) {
  assertWebCrypto(cryptoImpl);
  const keyPair = await cryptoImpl.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  );
  if (keyPair.privateKey.extractable) {
    throw new Error("The OAuth device key was not created securely.");
  }
  return keyPair;
}

async function loadOrCreateKeyPair({ indexedDBImpl, cryptoImpl, allowKeyCreation }) {
  const database = await openDatabase(indexedDBImpl);
  try {
    const saved = await readKeyPair(database);
    if (isUsableKeyPair(saved)) return saved;
    if (!allowKeyCreation) {
      throw deviceUnavailable("Refresh is unavailable in a private window. Reconnect Notion in a regular window.");
    }

    const keyPair = await generateOAuthDeviceKeyPair(cryptoImpl);
    await writeKeyPair(database, keyPair);
    return keyPair;
  } finally {
    database.close();
  }
}

function openDatabase(indexedDBImpl) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onerror = () => reject(request.error || new Error("Could not open secure device storage."));
    request.onblocked = () => reject(new Error("Secure device storage is temporarily unavailable."));
    request.onsuccess = () => resolve(request.result);
  });
}

function readKeyPair(database) {
  return transactionRequest(database, "readonly", (store) => store.get(KEY_ID));
}

function writeKeyPair(database, keyPair) {
  return transactionRequest(database, "readwrite", (store) => store.put(keyPair, KEY_ID));
}

function transactionRequest(database, mode, createRequest) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = createRequest(transaction.objectStore(STORE_NAME));
    let result;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error || new Error("Secure device storage failed."));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("Secure device storage failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Secure device storage was interrupted."));
  });
}

function isUsableKeyPair(value) {
  return value?.privateKey instanceof CryptoKey
    && value?.publicKey instanceof CryptoKey
    && value.privateKey.type === "private"
    && value.privateKey.algorithm?.name === "ECDSA"
    && value.privateKey.algorithm?.namedCurve === "P-256"
    && value.privateKey.usages.includes("sign")
    && value.privateKey.extractable === false
    && value.publicKey.type === "public"
    && value.publicKey.algorithm?.name === "ECDSA"
    && value.publicKey.algorithm?.namedCurve === "P-256";
}

function assertWebCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("Secure device cryptography is unavailable in this browser.");
  }
}

function deviceUnavailable(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "oauth_device_unavailable";
  return error;
}
