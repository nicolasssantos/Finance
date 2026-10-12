/* Configuração do armazenamento.
   - Sem o bloco "firebase": o app guarda os dados só neste navegador (modo local, serve para testar).
   - Com o bloco "firebase": login por e-mail e dados na nuvem (Firestore), iguais em todos os aparelhos.
   Esses valores não são segredo (identificam o projeto, não dão acesso); quem protege os dados são o login
   e as regras em firestore.rules. */
window.APP_CONFIG=window.APP_CONFIG||{
  firebase:{
    apiKey:'AIzaSyCy42H6UU62zObybHjVkfUi8GZLUz7OUUI',
    authDomain:'financas-mirante.firebaseapp.com',
    projectId:'financas-mirante',
    storageBucket:'financas-mirante.firebasestorage.app',
    messagingSenderId:'755982373158',
    appId:'1:755982373158:web:1cbadcbfdc52c5a39f71e7'
  }
};
