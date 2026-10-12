/* Armazenamento do Controle de Finanças.
   O app usa só esta interface (a mesma do Firestore):
     db.collection(nome).onSnapshot(ok, erro)   -> snap.docs[i].id / .data()
     db.doc('colecao/id').set(obj) / .delete() / .onSnapshot(ok, erro)   -> snap.exists / .data()
   Modo 'cloud': Firebase (login por e-mail + Firestore). Os dados ficam na nuvem e são iguais em todos os aparelhos.
   Modo 'local': IndexedDB. Os dados ficam só neste navegador. Usado quando config.js não tem o bloco "firebase". */
(function(){
'use strict';
var cfg=window.APP_CONFIG||{};
var FB_SCRIPTS=['vendor/firebase-app-compat.js','vendor/firebase-auth-compat.js','vendor/firebase-firestore-compat.js'];
var fbCfg=cfg.firebase&&cfg.firebase.apiKey&&cfg.firebase.projectId?cfg.firebase:null;
var auth=null,fs=null;

function clean(o){return JSON.parse(JSON.stringify(o))}

/* entrega o snapshot mais recente no máximo a cada `ms`, para uma importação grande não redesenhar o app a cada gravação */
function throttle(cb,ms){
  var last=0,timer=null,pend=null,dead=false;
  return {
    fn:function(snap){
      if(dead)return;
      var now=Date.now();
      if(!last||now-last>=ms){last=now;cb(snap);return}
      pend=snap;
      if(!timer)timer=setTimeout(function(){timer=null;if(dead)return;last=Date.now();var s=pend;pend=null;cb(s)},ms-(now-last));
    },
    cancel:function(){dead=true;clearTimeout(timer)}
  };
}

/* ---------- local: IndexedDB, com cópia em memória ---------- */
function openIdb(){
  return new Promise(function(res,rej){
    var r=indexedDB.open('finance-local',1);
    r.onupgradeneeded=function(){r.result.createObjectStore('docs')};
    r.onsuccess=function(){res(r.result)};
    r.onerror=function(){rej(r.error)};
  });
}
function loadAll(idb){
  return new Promise(function(res,rej){
    var mem={},t=idb.transaction('docs','readonly'),c=t.objectStore('docs').openCursor();
    c.onsuccess=function(){var k=c.result;if(k){mem[k.key]=k.value;k.continue()}};
    t.oncomplete=function(){res(mem)};
    t.onerror=function(){rej(t.error)};
  });
}
function localDb(){
  return openIdb().then(function(idb){return loadAll(idb).then(function(mem){return buildLocal(idb,mem)})});
}
function buildLocal(idb,mem){
  var cols={},docs={},timers={};
  var split=function(p){var i=p.indexOf('/');return [p.slice(0,i),p.slice(i+1)]};
  var mk=function(id,d){return {id:id,exists:true,data:function(){return d}}};
  function colSnap(n){var out=[];Object.keys(mem).forEach(function(p){var s=split(p);if(s[0]===n)out.push(mk(s[1],mem[p]))});return {docs:out}}
  function docSnap(p){var d=mem[p];return {id:split(p)[1],exists:d!==undefined,data:function(){return d}}}
  function fire(p){
    var n=split(p)[0];
    if(cols[n]&&cols[n].length&&!timers[n]){
      timers[n]=setTimeout(function(){timers[n]=null;var s=colSnap(n);(cols[n]||[]).slice().forEach(function(f){f(s)})},30);
    }
    (docs[p]||[]).slice().forEach(function(f){f(docSnap(p))});
  }
  function write(fn){
    return new Promise(function(res,rej){
      var t=idb.transaction('docs','readwrite');fn(t.objectStore('docs'));
      t.oncomplete=function(){res()};
      t.onerror=t.onabort=function(){rej(t.error||new Error('indexeddb'))};
    });
  }
  function sub(map,key,cb,first){
    (map[key]=map[key]||[]).push(cb);
    setTimeout(function(){if(map[key].indexOf(cb)>=0)cb(first())},0);
    return function(){map[key]=map[key].filter(function(f){return f!==cb})};
  }
  return {
    collection:function(n){return {onSnapshot:function(ok){return sub(cols,n,ok,function(){return colSnap(n)})}}},
    doc:function(p){return {
      set:function(o){var v=clean(o);return write(function(st){st.put(v,p)}).then(function(){mem[p]=v;fire(p)})},
      delete:function(){return write(function(st){st.delete(p)}).then(function(){delete mem[p];fire(p)})},
      onSnapshot:function(ok){return sub(docs,p,ok,function(){return docSnap(p)})}
    }}
  };
}

/* ---------- nuvem: Firestore, uma área por usuário (users/{uid}/...) ---------- */
function cloudDb(uid){
  var base='users/'+uid+'/';
  /* Com sinal ruim (comum na fazenda) o Firestore guarda a gravação no aparelho e envia depois.
     A promessa dele só resolve quando o servidor confirma. Sem internet seguimos na hora; com internet esperamos até 2,5 s.
     Se o servidor recusar depois (ex.: sessão vencida), avisamos pelo onWriteError. */
  function settle(p){
    p.catch(function(e){console.warn('firestore',e);if(B.onWriteError)B.onWriteError(e)});
    if(navigator.onLine===false)return Promise.resolve();
    return Promise.race([p,new Promise(function(r){setTimeout(r,2500)})]);
  }
  return {
    collection:function(n){return {onSnapshot:function(ok,err){
      var th=throttle(ok,250),un=fs.collection(base+n).onSnapshot(th.fn,err);
      return function(){th.cancel();un()};
    }}},
    doc:function(p){var ref=fs.doc(base+p);return {
      set:function(o){return settle(ref.set(clean(o)))},
      delete:function(){return settle(ref.delete())},
      onSnapshot:function(ok,err){return ref.onSnapshot(ok,err)}
    }}
  };
}

function loadSeq(urls){
  return urls.reduce(function(p,u){
    return p.then(function(){return new Promise(function(res,rej){
      var s=document.createElement('script');s.src=u;s.onload=res;s.onerror=function(){rej(new Error('Não carregou '+u))};document.head.appendChild(s);
    })});
  },Promise.resolve());
}
function authMsg(e){
  var c=e&&e.code||'';
  if(/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c))return 'E-mail ou senha incorretos.';
  if(/too-many-requests/.test(c))return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
  if(/network/.test(c))return 'Sem conexão. Confira a internet e tente de novo.';
  if(/user-disabled/.test(c))return 'Este usuário está desativado.';
  return 'Não consegui entrar ('+(c||'erro')+').';
}

var B=window.Backend={
  mode:fbCfg?'cloud':'local',
  user:null,
  onWriteError:null,
  init:function(){
    if(!fbCfg)return Promise.resolve();
    return loadSeq(FB_SCRIPTS).then(function(){
      firebase.initializeApp(fbCfg);
      auth=firebase.auth();fs=firebase.firestore();
      if(cfg.emulator){
        auth.useEmulator(cfg.emulator.auth,{disableWarnings:true});
        fs.useEmulator(cfg.emulator.firestore[0],cfg.emulator.firestore[1]);
      }
      fs.enablePersistence({synchronizeTabs:true}).catch(function(){});
      return new Promise(function(res){
        var first=true;
        auth.onAuthStateChanged(function(u){B.user=u;if(first){first=false;res()}});
      });
    });
  },
  signIn:function(email,pass){
    return auth.signInWithEmailAndPassword(email,pass).then(function(c){B.user=c.user;return c.user},function(e){throw new Error(authMsg(e))});
  },
  signOut:function(){return auth.signOut()},
  db:function(){
    if(B.mode==='cloud'){
      if(!B.user)return Promise.reject(new Error('sem login'));
      return Promise.resolve(cloudDb(B.user.uid));
    }
    if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
    return localDb();
  },
  download:function(name,blob){
    var a=document.createElement('a'),u=URL.createObjectURL(blob);
    a.href=u;a.download=name;document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(u);a.remove()},4000);
    return Promise.resolve();
  }
};
})();
