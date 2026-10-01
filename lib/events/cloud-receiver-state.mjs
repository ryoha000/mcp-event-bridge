import {createGcsObjectBackend} from '../gcs-store.mjs';
// All durable spool/lease/session/claim state uses generation CAS. No SQLite,
// local disk, FUSE transactions, synthetic namespace or OAuth state access.
export function createCloudReceiverState({bucketName,storage}){
 return createGcsObjectBackend({bucketName,storage,prefix:'discord-receiver/v1/',maxBytes:1024*1024,maxAttempts:5});
}
