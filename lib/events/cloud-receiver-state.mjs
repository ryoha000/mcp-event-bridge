import {createGcsObjectBackend} from '../gcs-store.mjs';
// 永続化するスプール/リース/セッション/クレーム状態はすべて世代CASを使う。
// SQLite、ローカルディスク、FUSEトランザクション、合成名前空間、
// OAuth状態へのアクセスは使わない。
export function createCloudReceiverState({bucketName,storage}){
 return createGcsObjectBackend({bucketName,storage,prefix:'discord-receiver/v1/',maxBytes:1024*1024,maxAttempts:5});
}
