/*
  Бункер — realtime.js
  Соединения устанавливаются сразу при входе, независимо от камеры.

  Новое поле — нужно один раз выполнить в Supabase SQL Editor:
    alter table seats add column extra_info text;
    alter table seats add column voted_for text;
    alter table seats add column vote_confirmed text;
    alter table seats add column revote_used text;
*/
(function(){
  var SUPABASE_URL = 'https://jgjsehordxptkqrlawfs.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_Ui8IHK2Q-WC8fehQgYHIwQ_oJ9y9_NG';

  if(!window.BunkerUI){ return; }
  if(!window.supabase){ return; }

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
      color: row.color,
      extraInfo: row.extra_info,
      votedFor: row.voted_for,
      voteConfirmed: row.vote_confirmed,
      revoteUsed: row.revote_used,
      details: {
        profession: row.profession, health: row.health, phobia: row.phobia,
        hobby: row.hobby, baggage: row.baggage, fact1: row.fact1, fact2: row.fact2
      }
    };
  }

  function patchToRow(seatId, patch){
    var row = { seat_id: seatId, updated_at: new Date().toISOString() };
    if('occupiedBy' in patch) row.occupied_by = patch.occupiedBy || null;
    if('nickname' in patch) row.nickname = patch.nickname;
    if('sub' in patch) row.sub = patch.sub;
    if('avatarDataUrl' in patch) row.avatar_data_url = patch.avatarDataUrl;
    if('color' in patch) row.color = patch.color || null;
    if('extraInfo' in patch) row.extra_info = patch.extraInfo || null;
    if('votedFor' in patch) row.voted_for = patch.votedFor || null;
    if('voteConfirmed' in patch) row.vote_confirmed = patch.voteConfirmed || null;
    if('revoteUsed' in patch) row.revote_used = patch.revoteUsed || null;
    if(patch.details) Object.keys(patch.details).forEach(function(k){ row[k] = patch.details[k]; });
    return row;
  }

  function loadInitialState(){
    client.from('seats').select('*').then(function(res){
      if(res.error) return;
      (res.data || []).forEach(function(row){ window.BunkerUI.applyRemoteSeat(row.seat_id, rowToPatch(row)); });
    });
  }

  function subscribeToSeatChanges(){
    client.channel('seats-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seats' }, function(payload){
        if(payload.new) window.BunkerUI.applyRemoteSeat(payload.new.seat_id, rowToPatch(payload.new));
      })
      .subscribe();
  }

  function pushSeatChange(seatId, patch){
    var row = patchToRow(seatId, patch);
    client.from('seats').upsert(row, { onConflict: 'seat_id' }).then(function(res){
      if(res.error) console.error('Supabase upsert error:', res.error);
    });
  }

  // ---------------- WebRTC ----------------
  var STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  var peers = {};
  var seatByUser = {};
  var localStream = null;
  var cameraActive = false;
  var roomChannel = null;
  var knownPeerIds = {};

  function updatePresence(){
    if(!roomChannel) return;
    roomChannel.track({ userId: myUserId, seatId: window.BunkerUI.getMySeatId() });
  }

  function sendSignal(toUserId, data){
    roomChannel.send({ type: 'broadcast', event: 'signal', payload: Object.assign({ from: myUserId, to: toUserId }, data) });
  }

  function getOrCreatePeer(otherUserId){
    var pc = peers[otherUserId];
    if(!pc){
      pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      peers[otherUserId] = pc;
      pc.onicecandidate = function(e){ if(e.candidate) sendSignal(otherUserId, { kind: 'ice', candidate: e.candidate }); };
      pc.ontrack = function(e){
        var seatId = seatByUser[otherUserId];
        if(seatId) window.BunkerUI.setSeatVideo(seatId, e.streams[0], true);
      };
    }

    // Добавляем локальные дорожки в существующее соединение В ЛЮБОЙ МОМЕНТ
    if(localStream){
      var alreadyAttached = pc.getSenders().map(function(s){ return s.track && s.track.id; });
      localStream.getTracks().forEach(function(track){
        if(alreadyAttached.indexOf(track.id) === -1) pc.addTrack(track, localStream);
      });
    }
    return pc;
  }

  function handleSignal(msg){
    var pc = getOrCreatePeer(msg.from);
    if(msg.kind === 'offer'){
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        .then(function(){ return pc.createAnswer(); })
        .then(function(answer){ return pc.setLocalDescription(answer).then(function(){ return answer; }); })
        .then(function(answer){ sendSignal(msg.from, { kind: 'answer', sdp: answer }); })
        .catch(function(err){ console.error('WebRTC answer error:', err); });
    } else if(msg.kind === 'answer'){
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch(function(err){ console.error('WebRTC setRemoteDescription error:', err); });
    } else if(msg.kind === 'ice'){
      pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(function(){});
    }
  }

  function offerTo(uid){
    var pc = getOrCreatePeer(uid);
    pc.createOffer()
      .then(function(offer){ return pc.setLocalDescription(offer).then(function(){ return offer; }); })
      .then(function(offer){ sendSignal(uid, { kind: 'offer', sdp: offer }); })
      .catch(function(err){ console.error('WebRTC offer error:', err); });
  }

  function connectToAllPeers(){
    Object.keys(seatByUser).forEach(function(uid){
      if(uid === myUserId) return;
      offerTo(uid);
    });
  }

  function setupRoomChannel(){
    roomChannel = client.channel('bunker-room', { config: { presence: { key: myUserId }, broadcast: { self: false } } });

    roomChannel.on('presence', { event: 'sync' }, function(){
      var state = roomChannel.presenceState();
      var updated = {};
      Object.keys(state).forEach(function(uid){
        var entry = state[uid] && state[uid][0];
        if(entry && entry.seatId) updated[uid] = entry.seatId;
      });
      seatByUser = updated;

      // ВАЖНО: Соединяемся со ВСЕМИ новыми пользователями сразу, без проверки камеры
      Object.keys(updated).forEach(function(uid){
        if(uid !== myUserId && !knownPeerIds[uid]){
          knownPeerIds[uid] = true;
          offerTo(uid); // Предложение будет отправлено, даже если у вас нет камеры!
        }
      });
    });

    roomChannel.on('broadcast', { event: 'signal' }, function(msg){
      var payload = msg.payload;
      if(!payload || payload.to !== myUserId) return;
      handleSignal(payload);
    });

    roomChannel.subscribe(function(status){ if(status === 'SUBSCRIBED') updatePresence(); });
  }

  function startCamera(seatId){
    navigator.mediaDevices.getUserMedia({ video: true })
      .then(function(stream){
        localStream = stream;
        cameraActive = true;
        window.BunkerUI.setSeatVideo(seatId, stream, true);
        window.BunkerUI.setCameraButtonState(true);
        // Соединения уже есть, просто добавляем дорожки
        Object.keys(peers).forEach(function(uid){ getOrCreatePeer(uid); });
        // И на всякий случай отправляем офферы всем заново
        connectToAllPeers();
      })
      .catch(function(err){ console.error('Camera error:', err); alert('Не удалось получить доступ к камере: ' + err.message); });
  }

  function stopCamera(seatId){
    if(localStream){ localStream.getTracks().forEach(function(t){ t.stop(); }); localStream = null; }
    Object.keys(peers).forEach(function(uid){ peers[uid].close(); delete peers[uid]; });
    cameraActive = false;
    window.BunkerUI.clearSeatVideo(seatId);
    window.BunkerUI.setCameraButtonState(false);
    // Пересоединяемся без локального потока, чтобы видеть чужие камеры
    Object.keys(knownPeerIds).forEach(function(uid){ delete knownPeerIds[uid]; });
    setupRoomChannel();
  }

  window.BunkerSync = {
    push: pushSeatChange,
    updatePresence: updatePresence,
    toggleCamera: function(seatId){
      if(cameraActive) stopCamera(seatId); else startCamera(seatId);
    },
    stopCameraIfActive: function(seatId){
      if(cameraActive) stopCamera(seatId);
    },
    refreshStatus: function(){
      loadInitialState(); updatePresence();
      Object.keys(peers).forEach(function(uid){ try { peers[uid].close(); } catch(e){} delete peers[uid]; });
      Object.keys(knownPeerIds).forEach(function(uid){ delete knownPeerIds[uid]; });
      if(roomChannel) roomChannel.unsubscribe().then(function(){ setupRoomChannel(); });
    }
  };

  loadInitialState();
  subscribeToSeatChanges();
  setupRoomChannel();
})();