/* Configuração do armazenamento.
   - Sem o bloco "firebase": o app guarda os dados só neste navegador (modo local, serve para testar).
   - Com o bloco "firebase": login por e-mail e dados na nuvem (Firestore), iguais em todos os aparelhos.
   Cole abaixo o objeto "firebaseConfig" do Console do Firebase (Configurações do projeto > Seus apps > Web).
   Esses valores não são segredo; quem protege os dados são o login e as regras em firestore.rules. */
window.APP_CONFIG=window.APP_CONFIG||{
  firebase:null
  /* firebase:{
    apiKey:'...',
    authDomain:'SEU-PROJETO.firebaseapp.com',
    projectId:'SEU-PROJETO',
    storageBucket:'SEU-PROJETO.firebasestorage.app',
    messagingSenderId:'...',
    appId:'...'
  } */
};
