/* ===========================================================================
   firebase-config.js — configuration only, so it can be swapped per
   environment without touching sync logic. Project and keys are UNCHANGED
   from the original file.

   Note on the data model: this app intentionally uses ONE shared Firestore
   document (`quizData/shared`) for a study group working across devices.
   That is a deliberate product decision, not an oversight — do not split it
   into per-user documents or add Auth without the owner's say-so. Access is
   governed by the project's Firestore security rules.
   =========================================================================== */

export const firebaseConfig = {
  apiKey: 'AIzaSyCyx8-ek848oCxkzn1PZGRmTa0OvhsYtV4',
  authDomain: 'gc-exam-master.firebaseapp.com',
  projectId: 'gc-exam-master',
  storageBucket: 'gc-exam-master.firebasestorage.app',
  messagingSenderId: '251811959274',
  appId: '1:251811959274:web:e337a17a5ec35baa4d6293',
  measurementId: 'G-P0RJBV6GSY'
};

export const SDK_VERSION = '10.7.1';
export const COLLECTION = 'quizData';
export const DOCUMENT = 'shared';
