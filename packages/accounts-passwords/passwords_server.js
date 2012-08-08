(function () {

  // internal verifier collection. Never published.
  Meteor.accounts._srpChallenges = new Meteor.Collection(
    "accounts._srpChallenges",
    null /*manager*/,
    null /*driver*/,
    true /*preventAutopublish*/);

  var selectorFromUserQuery = function (user) {
    if (!user)
      throw new Meteor.Error(400, "Must pass a user property in request");
    if (_.keys(user).length !== 1)
      throw new Meteor.Error(400, "User property must have exactly one field");

    var selector;
    if (user.id)
      selector = {_id: user.id};
    else if (user.username)
      selector = {username: user.username};
    else if (user.email)
      selector = {emails: user.email};
    else
      throw new Meteor.Error(400, "Must pass username, email, or id in request.user");

    return selector;
  };

  Meteor.methods({
    // @param request {Object} with fields:
    //   user: either {username: (username)}, {email: (email)}, or {id: (userId)}
    //   A: hex encoded int. the client's public key for this exchange
    // @returns {Object} with fields:
    //   identiy: string uuid
    //   salt: string uuid
    //   B: hex encoded int. server's public key for this exchange
    beginPasswordExchange: function (request) {
      var selector = selectorFromUserQuery(request.user);

      var user = Meteor.users.findOne(selector);
      if (!user)
        throw new Meteor.Error(403, "User not found");

      if (!user.services || !user.services.password ||
          !user.services.password.srp)
        throw new Meteor.Error(403, "User has no password set");

      var verifier = user.services.password.srp;
      var srp = new Meteor._srp.Server(verifier);
      var challenge = srp.issueChallenge({A: request.A});

      // XXX It would be better to put this on the session
      // somehow. However, this gets complicated when interacting with
      // reconnect on the client. The client should detect the reconnect
      // and re-start the exchange.
      // https://app.asana.com/0/988582960612/1278583012594
      //
      // Instead we store M and HAMK from SRP (abstraction violation!)
      // and let any session login if it knows M. This is somewhat
      // insecure, if you don't use SSL someone can sniff your traffic
      // and then log in as you (but no more insecure than reconnect
      // tokens).
      var serialized = { userId: user._id, M: srp.M, HAMK: srp.HAMK };
      Meteor.accounts._srpChallenges.insert(serialized);

      return challenge;
    },

    changePassword: function (options) {
      if (!this.userId())
        throw new Meteor.Error(401, "Must be logged in");

      // If options.M is set, it means we went through a challenge with
      // the old password.

      if (!options.M && !Meteor.accounts._options.unsafePasswordChanges) {
        throw new Meteor.Error(403, "Old password required.");
      }

      if (options.M) {
        var serialized = Meteor.accounts._srpChallenges.findOne(
          {M: options.M});
        if (!serialized)
          throw new Meteor.Error(403, "Incorrect password");
        if (serialized.userId !== this.userId())
          // No monkey business!
          throw new Meteor.Error(403, "Incorrect password");
      }

      var verifier = options.srp;
      if (!verifier && options.password) {
        verifier = Meteor._srp.generateVerifier(options.password);
      }
      if (!verifier || !verifier.identity || !verifier.salt ||
          !verifier.verifier)
        throw new Meteor.Error(400, "Invalid verifier");

      Meteor.users.update({_id: this.userId()},
                          {$set: {'services.password.srp': verifier}});

      var ret = {passwordChanged: true};
      if (serialized)
        ret.HAMK = serialized.HAMK;
      return ret;
    },

    createUser: function (options, extra) {
      extra = extra || {};
      var username = options.username;
      var email = options.email;
      if (!username && !email)
        throw new Meteor.Error(400, "Need to set a username or email");
      if (options.validation && !options.baseUrl)
        throw new Meteor.Error(
          400, "If options.validation is set, need to pass options.baseUrl");
      if (username && Meteor.users.findOne({username: username}))
        throw new Meteor.Error(403, "User already exists with username " + username);
      if (email && Meteor.users.findOne({emails: email})) {
        if (Meteor.users.findOne({validatedEmails: email})) {
          throw new Meteor.Error(403, "User already exists with validated email " + email);
        } else {
          // XXX better message? or some other flow?
          throw new Meteor.Error(403, "User already exists with unvalidated email " + email +
                                 ". If you own this address you can gain "
                                 + "access by using the 'Forgot Password' link");
        }
      }

      // XXX validate verifier

      // raw password, should only be used over SSL!
      if (options.password) {
        if (options.srp)
          throw new Meteor.Error(400, "Don't pass both password and srp in options");
        options.srp = Meteor._srp.generateVerifier(options.password);
      }

      var user = {services: {password: {srp: options.srp}}};
      if (username)
        user.username = username;
      if (email)
        user.emails = [email];

      user = Meteor.accounts.onCreateUserHook(options, extra, user);
      var userId = Meteor.users.insert(user);

      // If `options.validation` is set, register a token to validate
      // the user's primary email, and send it to that address.
      if (email && options.validation)
        Meteor.accounts.sendValidationEmail(userId, email, options.baseUrl);

      var loginToken = Meteor.accounts._loginTokens.insert({userId: userId});
      this.setUserId(userId);
      return {token: loginToken, id: userId};
    },

    forgotPassword: function (options) {
      var email = options.email;
      var baseUrl = options.baseUrl;
      if (!email)
        throw new Meteor.Error(400, "Need to set options.email");
      if (!baseUrl)
        throw new Meteor.Error(400, "Need to set options.baseUrl");

      var user = Meteor.users.findOne({emails: email});
      if (!user)
        throw new Meteor.Error(403, "User not found");

      var token = Meteor.uuid();
      var creationTime = +(new Date);
      Meteor.users.update(user._id, {$set: {
        "services.password.reset": {
          token: token,
          creationTime: creationTime
        }
      }});

      // XXX definitely *not* the final form!
      Meteor.mail.send(email, Meteor.accounts.urls.resetPassword(baseUrl, token));
    },

    resetPassword: function (token, newVerifier) {
      if (!token)
        throw new Meteor.Error(400, "Need to pass token");
      if (!newVerifier)
        throw new Meteor.Error(400, "Need to pass newVerifier");

      var user = Meteor.users.findOne({"services.password.reset.token": token});
      if (!user)
        throw new Meteor.Error(403, "Reset password link expired");

      Meteor.users.update({_id: user._id}, {
        $set: {'services.password.srp': newVerifier},
        $unset: {'services.password.reset': 1}
      });

      var loginToken = Meteor.accounts._loginTokens.insert({userId: user._id});
      this.setUserId(user._id);
      return {token: loginToken, id: user._id};
    },

    validateEmail: function (token) {
      if (!token)
        throw new Meteor.Error(400, "Need to pass token");

      var tokenDocument = Meteor.accounts._emailValidationTokens.findOne(
        {token: token});
      if (!tokenDocument)
        throw new Meteor.Error(403, "Validate email link expired");
      var userId = tokenDocument.userId;

      Meteor.users.update({_id: userId},
                          {$push: {validatedEmails: tokenDocument.email}});
      Meteor.accounts._emailValidationTokens.remove({token: token});

      var loginToken = Meteor.accounts._loginTokens.insert({userId: userId});
      this.setUserId(userId);
      return {token: loginToken, id: userId};
    }
  });

  // send the user an email with a link that when opened marks that
  // address as validated
  Meteor.accounts.sendValidationEmail = function (userId, email, appBaseUrl) {
    var token = Meteor.uuid();
    var creationTime = +(new Date);
    Meteor.accounts._emailValidationTokens.insert({
      email: email,
      token: token,
      creationTime: creationTime,
      userId: userId
    });

    // XXX Also generate a link using which someone can delete this
    // account if they own said address but weren't those who created
    // this account.
    Meteor.mail.send(
      email,
      Meteor.accounts.urls.validateEmail(appBaseUrl, token));
  };

  // handler to login with password
  Meteor.accounts.registerLoginHandler(function (options) {
    if (!options.srp)
      return undefined; // don't handle
    if (!options.srp.M)
      throw new Meteor.Error(400, "Must pass M in options.srp");

    var serialized = Meteor.accounts._srpChallenges.findOne(
      {M: options.srp.M});
    if (!serialized)
      throw new Meteor.Error(403, "Incorrect password");

    var userId = serialized.userId;
    var loginToken = Meteor.accounts._loginTokens.insert({userId: userId});

    // XXX we should remove srpChallenge documents from mongo, but we
    // need to make sure reconnects still work (meaning we can't
    // remove them right after they've been used). This will also be
    // fixed if we store challenges in session.
    // https://app.asana.com/0/988582960612/1278583012594

    return {token: loginToken, id: userId, HAMK: serialized.HAMK};
  });

  // handler to login with plaintext password.
  //
  // The meteor client doesn't use this, it is for other DDP clients who
  // haven't implemented SRP. Since it sends the password in plaintext
  // over the wire, it should only be run over SSL!
  //
  // Also, it might be nice if servers could turn this off. Or maybe it
  // should be opt-in, not opt-out? Meteor.accounts.config option?
  Meteor.accounts.registerLoginHandler(function (options) {
    if (!options.password || !options.user)
      return undefined; // don't handle

    var selector = selectorFromUserQuery(options.user);
    var user = Meteor.users.findOne(selector);
    if (!user)
      throw new Meteor.Error(403, "User not found");

    if (!user.services || !user.services.password ||
        !user.services.password.srp)
      throw new Meteor.Error(403, "User has no password set");

    // Just check the verifier output when the same identity and salt
    // are passed. Don't bother with a full exchange.
    var verifier = user.services.password.srp;
    var newVerifier = Meteor._srp.generateVerifier(options.password, {
      identity: verifier.identity, salt: verifier.salt});

    if (verifier.verifier !== newVerifier.verifier)
      throw new Meteor.Error(403, "Incorrect password");

    var loginToken = Meteor.accounts._loginTokens.insert({userId: user._id});
    return {token: loginToken, id: user._id};
  });

})();


Meteor.mail = {};
Meteor.mail.send = function() {
  console.log("Send mail:");
  console.log(arguments);
};
