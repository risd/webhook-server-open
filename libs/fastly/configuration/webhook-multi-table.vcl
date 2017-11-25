# does not work
# can not do a table.lookup on a `string`
# must be done on a variable name, not a string
# that represents a variable name

table edutest_risd_systems_redirect_one_to_one_urls {
  "/summerstudies/": "https://summer.risd.edu",
  "/teaching+learning-in-art+design/": "/academics/teaching-learning-in-art-design/",
  "/teaching-learning-in-art-design/": "/academics/teaching-learning-in-art-design/",
  "/textiles/": "/academics/textiles/",
  "/thesis/": "http://gradshow.risd.edu/",
  "/tlad/": "/academics/teaching-learning-in-art-design/",
  "/uploadedFiles/RISD_edu/About_RISD/FAQ/fact_book_2016_160511.pdf": "http://info.risd.edu/webhook-uploads/1462988813309/fact_book_2016_160511.pdf",
  "/videos/": "https://vimeo.com/risd",
  "/viewbook/": "https://admissions.risd.edu/register/information_request/",
  "/visit/": "/about/visiting-risd/",
  "/welcome/": "http://congratulations.risd.edu/",
  "/wintersession/": "/academics/wintersession/",
  "/xyz/": "/alumni/risd-xyz/",
  "/xyzmail/": "/alumni/risd-xyz/",
}

table diff_edutest_risd_systems_redirect_one_to_one_urls {
  "/summerstudies/": "https://summer.risd.edu",
  "/teaching+learning-in-art+design/": "/academics/teaching-learning-in-art-design/",
  "/teaching-learning-in-art-design/": "/academics/teaching-learning-in-art-design/",
  "/textiles/": "/academics/textiles/",
  "/thesis/": "http://gradshow.risd.edu/",
  "/tlad/": "/academics/teaching-learning-in-art-design/",
  "/uploadedFiles/RISD_edu/About_RISD/FAQ/fact_book_2016_160511.pdf": "http://info.risd.edu/webhook-uploads/1462988813309/fact_book_2016_160511.pdf",
  "/videos/": "https://vimeo.com/risd",
  "/viewbook/": "https://admissions.risd.edu/register/information_request/",
  "/visit/": "/about/visiting-risd/",
  "/welcome/": "http://congratulations.risd.edu/",
  "/wintersession/": "/academics/wintersession/",
  "/xyz/": "/alumni/risd-xyz/",
  "/xyzmail/": "/alumni/risd-xyz/",
}


sub vcl_recv {
#FASTLY recv
        
    
  # Snippet recv_trailing_slash : 99
  if ( req.url !~ {"(?x)
 (?:/$) # last character isn't a slash
 | # or 
 (?:/\?) # query string isn't immediately preceded by a slash
 "} &&
 req.url ~ {"(?x)
 (?:/[^./]+$) # last path segment doesn't contain a . no query string
 | # or
 (?:/[^.?]+\?) # last path segment doesn't contain a . with a query string
 "} ) {
  set req.url = req.url + "/";

  error 301;
}

  # Snippet recv_redirect_urls : 100
  declare local var.host_table_name STRING;
  declare local var.redirect_url STRING;

  set var.host_table_name = regsuball( req.http.host, ".", "_" ) "_redirect_one_to_one_urls";

  if ( table.lookup( regsub( req.http.host, "/./g", "_" ) "_redirect_one_to_one_urls", req.url.path ) ) {
    set var.redirect_url = table.lookup( var.host_table_name, req.url.path );
  if ( var.redirect_url ~ "^(http)?"  ) {
    set req.http.x-redirect-location = var.redirect_url;
  } else {
    set req.http.x-redirect-location = "http://" var.redirect_url;
  }
  
  error 301;
}

  # Snippet redirect_1c1t3b1e2f201y2y263b1c2f332c33362q1b1d1w22291p1p : 100
  if ( req.http.host == "diff.edutest.risd.systems" && req.url ~ "^/academics/painting/faculty/." ) {
  set req.http.x-redirect-location = "http://" req.http.host "/academics/painting/faculty/";
  error 301;
}
#--FASTLY RECV END



  if (req.request != "HEAD" && req.request != "GET" && req.request != "FASTLYPURGE") {
    return(pass);
  }


  return(lookup);
}

sub vcl_fetch {
#FASTLY fetch

  if ((beresp.status == 500 || beresp.status == 503) && req.restarts < 1 && (req.request == "GET" || req.request == "HEAD")) {
    restart;
  }

  if (req.restarts > 0) {
    set beresp.http.Fastly-Restarts = req.restarts;
  }

  if (beresp.http.Set-Cookie) {
    set req.http.Fastly-Cachetype = "SETCOOKIE";
    return(pass);
  }

  if (beresp.http.Cache-Control ~ "private") {
    set req.http.Fastly-Cachetype = "PRIVATE";
    return(pass);
  }

  if (beresp.status == 500 || beresp.status == 503) {
    set req.http.Fastly-Cachetype = "ERROR";
    set beresp.ttl = 1s;
    set beresp.grace = 5s;
    return(deliver);
  }

  if (beresp.http.Expires || beresp.http.Surrogate-Control ~ "max-age" || beresp.http.Cache-Control ~ "(s-maxage|max-age)") {
    # keep the ttl here
  } else {
    # apply the default ttl
    set beresp.ttl = 3600s;
  }

  return(deliver);
}

sub vcl_hit {
#FASTLY hit

  if (!obj.cacheable) {
    return(pass);
  }
  return(deliver);
}

sub vcl_miss {
#FASTLY miss
  return(fetch);
}

sub vcl_deliver {
#FASTLY deliver
  return(deliver);
}

sub vcl_error {
#FASTLY error
}

sub vcl_pass {
#FASTLY pass
}

sub vcl_log {
#FASTLY log
}
