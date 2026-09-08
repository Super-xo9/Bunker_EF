/*
  Бункер — realtime.js
  ---------------------
  Синхронизация мест (кто где сидит, ник, аватар, поля карточки) между
  всеми, кто открыл сайт, плюс передача камеры между игроками.

  ЧТО НУЖНО СДЕЛАТЬ ПЕРЕД ЗАПУСКОМ:

  1. Зарегистрироваться на supabase.com (бесплатный тариф достаточен),
     создать новый проект.

  2. В разделе SQL Editor выполнить:

       create table seats (
         seat_id text primary key,
         occupied_by text,
         nickname text,
         sub text,
         avatar_data_url text,
         profession text,
         health text,
         phobia text,
         hobby text,
         baggage text,
         fact1 text,
         fact2 text,
         updated_at timestamptz default now()
       );

       alter table seats enable row level security;

       create policy "public read"   on seats for select using (true);
       create policy "public insert" on seats for insert with check (true);
       create policy "public update" on seats for update using (true);

       alter publication supabase_realtime add table seats;

     Важно: политики выше открывают чтение/запись всем, у кого есть
     анонимный ключ (он в любом случае виден в исходнике страницы).
     Это нормально для игры в компании друзей, но не для сайта,
     который смотрят посторонние — там нужна была бы авторизация.

  3. В Project Settings -> API скопировать Project URL и anon public key,
     вставить их ниже вместо SUPABASE_URL / SUPABASE_ANON_KEY.

  4. Положить этот файл рядом с основным html и подключить (уже сделано
     в html): <script src="realtime.js"></script> после supabase-js.

  ИЗВЕСТНЫЕ ОГРАНИЧЕНИЯ КАМЕРЫ:
  - Используется только STUN (публичный сервер Google) — без TURN.
    На части мобильных/корпоративных сетей соединение между двумя
    конкретными браузерами может не установиться. Если это станет
    проблемой — понадобится бесплатный/платный TURN (например Metered.ca).
  - Прямые P2P-соединения "каждый с каждым" нормально работают человек
    до ~10-12 одновременно; для большего числа понадобился бы отдельный
    медиасервер (SFU), это уже не в рамках одного файла.
*/
(function(){

  // ====== ЗАПОЛНИ ЭТИ ДВЕ СТРОКИ СВОИМИ ДАННЫМИ ИЗ SUPABASE ======
  var SUPABASE_URL = 'https://jgjsehordxptkqrlawfs.supabase.co/rest/v1/';
  var SUPABASE_ANON_KEY = 'sb_publishable_Ui8IHK2Q-WC8fehQgYHIwQ_oJ9y9_NG';
  // =================================================================

  if(!window.BunkerUI){
    console.error('realtime.js: BunkerUI не найден — подключай этот файл после основного <script> на странице.');
    return;
  }

  if(!window.supabase){
    console.error('realtime.js: не найдена библиотека supabase-js — проверь порядок <script> тегов.');
    return;
  }

  if(SUPABASE_URL.indexOf('YOUR-PROJECT') !== -1 || SUPABASE_ANON_KEY.indexOf('YOUR-ANON') !== -1){
    console.warn('realtime.js: заполни SUPABASE_URL и SUPABASE_ANON_KEY в этом файле — синхронизация выключена, сайт работает только локально.');
    return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var myUserId = window.BunkerUI.getMyUserId();

  var LEFT_KEYS = ['profession', 'health', 'phobia', 'hobby'];
  var RIGHT_KEYS = ['baggage', 'fact1', 'fact2'];

  function rowToPatch(row){
    return {
      occupiedBy: row.occupied_by || '',
      nickname: row.nickname,
      sub: row.sub,
      avatarDataUrl: row.avatar_data_url,
      details: {
        profession: row.profession,
        health: row.health,
        phobia: row.phobia,
        hobby: row.hobby,
        baggage: row.baggage,
        fact1: row.fact1,
        fact2: row.fact2
      }
    };
  }

  function patchToRow(seatId, patch){
    var row = { seat_id: seatId, updated_at: new Date().toISOString() };
    if('occupiedBy' in patch) row.occupied_by = patch.occupiedBy || null;
    if('nickname' in patch) row.nickname = patch.nickname;
    if('sub' in patch) row.sub = patch.sub;
    if('avatarDataUrl' in patch) row.avatar_data_url = patch.avatarDataUrl;
    if(patch.details){
      Object.keys(patch.details).forEach(function(k){ row[k] = patch.details[k]; });
    }
    return row;
  }

  function loadInitialState(){
    client.from('seats').select('*').then(function(res){
      if(res.error){ console.error('Supabase select error:', res.error); return; }
      (res.data || []).forEach(function(row){
        window.BunkerUI.applyRemoteSeat(row.seat_id, rowToPatch(row));
      });
    });
  }

  function subscribeToSeatChanges(){
    client
      .channel('seats-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seats' }, function(payload){
        var row = payload.new;
        if(!row) return;
        window.BunkerUI.applyRemoteSeat(row.seat_id, rowToPatch(row));
      })
      .subscribe();
  }

  function pushSeatChange(seatId, patch){
    var row = patchToRow(seatId, patch);
    client.from('seats').upsert(row, { onConflict: 'seat_id' }).then(function(res){
      if(res.error) console.error('Supabase upsert error:', res.error);
    });
  }

  // ---------------- WebRTC (камера) ----------------

  var STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  var peers = {};       // userId -> RTCPeerConnection
  var seatByUser = {};  // userId -> seatId, из presence
  var localStream = null;
  var cameraActive = false;
  var roomChannel = null;

  function updatePresence(){
    if(!roomChannel) return;
    roomChannel.track({ userId: myUserId, seatId: window.BunkerUI.getMySeatId() });
  }

  function sendSignal(toUserId, data){
    roomChannel.send({
      type: 'broadcast',
      event: 'signal',
      payload: Object.assign({ from: myUserId, to: toUserId }, data)
    });
  }

  function getOrCreatePeer(otherUserId){
    if(peers[otherUserId]) return peers[otherUserId];

    var pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    peers[otherUserId] = pc;

    if(localStream){
      localStream.getTracks().forEach(function(track){ pc.addTrack(track, localStream); });
    }

    pc.onicecandidate = function(e){
      if(e.candidate) sendSignal(otherUserId, { kind: 'ice', candidate: e.candidate });
    };

    pc.ontrack = function(e){
      var seatId = seatByUser[otherUserId];
      if(seatId) window.BunkerUI.setSeatVideo(seatId, e.streams[0], false);
    };

    return pc;
  }

  function handleSignal(msg){
    var pc = getOrCreatePeer(msg.from);

    if(msg.kind === 'offer'){
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        .then(function(){ return pc.createAnswer(); })
        .then(function(answer){
          return pc.setLocalDescription(answer).then(function(){ return answer; });
        })
        .then(function(answer){ sendSignal(msg.from, { kind: 'answer', sdp: answer }); })
        .catch(function(err){ console.error('WebRTC answer error:', err); });
    } else if(msg.kind === 'answer'){
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        .catch(function(err){ console.error('WebRTC setRemoteDescription error:', err); });
    } else if(msg.kind === 'ice'){
      pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(function(){});
    }
  }

  function connectToAllPeers(){
    Object.keys(seatByUser).forEach(function(uid){
      if(uid === myUserId) return;
      var pc = getOrCreatePeer(uid);
      pc.createOffer()
        .then(function(offer){
          return pc.setLocalDescription(offer).then(function(){ return offer; });
        })
        .then(function(offer){ sendSignal(uid, { kind: 'offer', sdp: offer }); })
        .catch(function(err){ console.error('WebRTC offer error:', err); });
    });
  }

  function setupRoomChannel(){
    roomChannel = client.channel('bunker-room', {
      config: {
        presence: { key: myUserId },
        broadcast: { self: false }
      }
    });

    roomChannel.on('presence', { event: 'sync' }, function(){
      var state = roomChannel.presenceState();
      seatByUser = {};
      Object.keys(state).forEach(function(uid){
        var entry = state[uid] && state[uid][0];
        if(entry && entry.seatId) seatByUser[uid] = entry.seatId;
      });
    });

    roomChannel.on('broadcast', { event: 'signal' }, function(msg){
      var payload = msg.payload;
      if(!payload || payload.to !== myUserId) return;
      handleSignal(payload);
    });

    roomChannel.subscribe(function(status){
      if(status === 'SUBSCRIBED') updatePresence();
    });
  }

  function startCamera(seatId){
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(function(stream){
        localStream = stream;
        cameraActive = true;
        window.BunkerUI.setSeatVideo(seatId, stream, true);
        window.BunkerUI.setCameraButtonState(true);
        connectToAllPeers();
      })
      .catch(function(err){
        console.error('Camera error:', err);
        alert('Не удалось получить доступ к камере: ' + err.message);
      });
  }

  function stopCamera(seatId){
    if(localStream){
      localStream.getTracks().forEach(function(t){ t.stop(); });
      localStream = null;
    }
    Object.keys(peers).forEach(function(uid){
      peers[uid].close();
      delete peers[uid];
    });
    cameraActive = false;
    window.BunkerUI.clearSeatVideo(seatId);
    window.BunkerUI.setCameraButtonState(false);
  }

  window.BunkerSync = {
    push: pushSeatChange,
    updatePresence: updatePresence,
    toggleCamera: function(seatId){
      if(cameraActive) stopCamera(seatId);
      else startCamera(seatId);
    }
  };

  loadInitialState();
  subscribeToSeatChanges();
  setupRoomChannel();
})();
